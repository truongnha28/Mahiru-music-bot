// Map lưu thời gian Mahiru trả lời từ khóa gần nhất theo từng Channel
const keywordCooldowns = new Map();
const KEYWORD_COOLDOWN_MS = 2 * 60 * 1000; // 2 phút cooldown cho từ khóa có cooldown

require("dotenv").config();
const path = require("path");
const fs = require("fs");

const {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  demuxProbe,
} = require("@discordjs/voice");

// THƯ VIỆN NHẠC MỚI
// @distube/ytdl-core đã bị archive (ngừng bảo trì) từ 16/8/2025 nên không còn
// theo kịp các thay đổi decipher/n-transform của YouTube -> gây lỗi 403 khi phát.
// @distube/ytpl cũng hay bị lỗi "Unsupported Playlist response" vì YouTube đổi
// cấu trúc trang playlist. Chuyển toàn bộ sang yt-dlp (qua youtube-dl-exec) vì
// đây là công cụ được cộng đồng cập nhật liên tục, xử lý tốt các thay đổi phía YouTube.
const youtubedl = require("youtube-dl-exec");

// Nhận diện link video YouTube đơn lẻ (thay cho ytdl.validateURL đã lỗi thời)
function isYoutubeVideoUrl(input) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]{6,}/i.test(
    input
  );
}

// Nhận diện link Playlist YouTube (có "list=" nhưng KHÔNG kèm "v=" 1 video cụ thể)
function isYoutubePlaylistUrl(input) {
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    return url.searchParams.has("list") && !url.searchParams.has("v");
  } catch {
    return false;
  }
}

// Lấy danh sách bài hát trong 1 Playlist YouTube bằng yt-dlp (không tải nội dung)
async function getYoutubePlaylistItems(url) {
  try {
    const result = await youtubedl(url, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
      cookiesFromBrowser: "safari",
    });

    const entries = (result?.entries || []).filter((e) => e && (e.id || e.url));
    const items = entries.map((e) => ({
      title: e.title || "Không rõ tên bài hát",
      url:
        e.url && e.url.startsWith("http")
          ? e.url
          : `https://www.youtube.com/watch?v=${e.id}`,
    }));

    return { title: result?.title || "Playlist YouTube", items };
  } catch (err) {
    console.error("Lỗi lấy playlist YouTube:", err.message);
    return { title: "Playlist YouTube", items: [] };
  }
}

async function searchAndPlay(query) {
  try {
    // Tìm video đầu tiên khớp với query
    const searchResult = await youtubedl(`ytsearch1:${query}`, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      noCheckCertificates: true,
      cookiesFromBrowser: "safari",
    });

    if (!searchResult?.entries || searchResult.entries.length === 0) {
      throw new Error("Không tìm thấy video");
    }

    const firstResult = searchResult.entries[0];
    const videoUrl = firstResult.url || `https://www.youtube.com/watch?v=${firstResult.id}`;
    const title = firstResult.title || "Video tìm kiếm";

    return { url: videoUrl, title };
  } catch (err) {
    console.error("Lỗi tìm kiếm:", err);
    throw err;
  }
}

// Lấy tiêu đề 1 video YouTube mà KHÔNG tải nội dung (chỉ để hiển thị trong queue)
async function getYoutubeTitle(url) {
  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
      skipDownload: true,
      noPlaylist: true,
      cookiesFromBrowser: "safari",
    });
    return info?.title || null;
  } catch (err) {
    console.error("Lỗi lấy thông tin video YouTube:", err.message);
    return null;
  }
}

// Thêm 1 link YouTube (video lẻ hoặc playlist) vào songQueue. Dùng chung cho lệnh
// /playlink, /loop, và cho việc tự nạp lại danh sách khi chế độ lặp (/loop) đang bật.
// Trả về { type: 'playlist' | 'video', title, count }.
// Ném lỗi với message "EMPTY_PLAYLIST" hoặc "INVALID_LINK" khi link không dùng được.
async function addYoutubeLinkToQueue(input) {
  if (isYoutubePlaylistUrl(input)) {
    const { title: playlistTitle, items } = await getYoutubePlaylistItems(input);

    if (items.length === 0) {
      throw new Error("EMPTY_PLAYLIST");
    }

    // Chỉ lấy tên đầy đủ của từng video, tớ sẽ tự tìm & phát trên YouTube
    // ngay trước khi đến lượt bài đó
    items.forEach((item) => {
      songQueue.push({
        title: item.title,
        query: item.title,
        type: "search",
      });
    });

    return { type: "playlist", title: playlistTitle, count: items.length };
  } else if (isYoutubeVideoUrl(input)) {
    const title = await getYoutubeTitle(input);
    songQueue.push({
      title: title || "Video YouTube",
      url: input,
      type: "stream",
    });

    return { type: "video", title: title || input, count: 1 };
  } else {
    throw new Error("INVALID_LINK");
  }
}
// Theo dõi tiến trình yt-dlp đang chạy để có thể kill dứt điểm khi /skip, /stop
// hoặc khi chuyển sang bài tiếp theo (tránh tiến trình cũ chạy nền gây lỗi ngầm)
let activeSubprocess = null;

function killActiveSubprocess() {
  if (activeSubprocess && !activeSubprocess.killed) {
    try {
      activeSubprocess.kill();
    } catch (_) {
      // Bỏ qua, tiến trình có thể đã tự thoát rồi
    }
  }
  activeSubprocess = null;
}

// Tạo AudioResource bằng cách stream trực tiếp từ yt-dlp (không cần tải file tạm)
// `source` có thể là 1 URL YouTube thật, HOẶC chuỗi "ytsearch1:<từ khóa>" để yt-dlp
// tự tìm và phát video đầu tiên khớp với từ khóa (dùng để lazy-resolve bài trong Playlist YouTube).
async function createResourceFromSource(source) {
  // Kill tiến trình cũ nếu có
  killActiveSubprocess();

  const subprocess = youtubedl.exec(
    source,
    {
      output: "-",
      format: "bestaudio/best",  // Nếu không có track chỉ-âm-thanh riêng (một số video chỉ trả về HLS gộp video+audio), tự lấy track tốt nhất thay vì báo lỗi "format not available"
      noPlaylist: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      // Dùng cookie từ Safari (đã đăng nhập YouTube) để tránh lỗi "HTTP Error 403:
      // Forbidden" - YouTube gần đây yêu cầu xác thực cho nhiều video/IP, cookie giúp
      // yt-dlp được xem như 1 trình duyệt thật đã đăng nhập thay vì bị chặn.
      // Nếu đổi máy/trình duyệt khác thì đổi "safari" thành "chrome" hoặc "firefox".
      cookiesFromBrowser: "safari",
      // Thêm retry để ổn định hơn. Không ép player_client nữa - để yt-dlp tự chọn
      // (nó tự dùng "tv downgraded" khi có cookie, hoạt động tốt hơn ép tay).
      retries: 10,
      fragmentRetries: 10,
    },
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  subprocess.catch((err) => {
    // Chỉ log lỗi nếu không phải do bị kill
    if (err?.killed !== true) {
      console.warn(
        "[yt-dlp] Tiến trình kết thúc bất thường:",
        err?.shortMessage || err?.message || err
      );
      // In toàn bộ chi tiết lỗi (không chỉ .stderr, vì có trường hợp .stderr rỗng
      // dù tiến trình vẫn thoát lỗi - ví dụ binary yt-dlp không chạy được).
      console.warn("[yt-dlp][chi tiết đầy đủ]:", {
        exitCode: err?.exitCode,
        code: err?.code, // vd: EACCES / ENOENT nếu không spawn được binary
        signal: err?.signal,
        stderr: err?.stderr,
        stdout: err?.stdout,
        path: err?.path,
      });
    }
  });

  activeSubprocess = subprocess;

  if (!subprocess.stdout) {
    throw new Error("Không lấy được luồng âm thanh từ yt-dlp.");
  }

  try {
    const { stream, type } = await demuxProbe(subprocess.stdout);
    return createAudioResource(stream, { inputType: type });
  } catch (err) {
    if (!subprocess.killed) subprocess.kill();
    throw err;
  }
}

const { GoogleGenAI } = require("@google/genai");

// ------------------------------------------------------------------
// CẤU HÌNH DATABASE SQLITE3 LƯU KÝ ỨC
// ------------------------------------------------------------------
const sqlite3 = require("sqlite3").verbose();
const dbPath = path.join(__dirname, "memories.sqlite");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

const MAX_MEMORIES_PER_USER = 15;

function getUserMemories(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT id, fact FROM memories WHERE user_id = ? ORDER BY id ASC",
      [userId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

function addUserMemory(userId, fact) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT COUNT(*) as count FROM memories WHERE user_id = ?",
      [userId],
      (err, row) => {
        if (err) return reject(err);

        if (row.count >= MAX_MEMORIES_PER_USER) {
          return resolve({ success: false, reason: "limit" });
        }

        db.get(
          "SELECT id FROM memories WHERE user_id = ? AND fact = ?",
          [userId, fact],
          (err, duplicate) => {
            if (err) return reject(err);
            if (duplicate) return resolve({ success: false, reason: "duplicate" });

            db.run(
              "INSERT INTO memories (user_id, fact) VALUES (?, ?)",
              [userId, fact],
              function (err) {
                if (err) return reject(err);
                resolve({ success: true, id: this.lastID });
              }
            );
          }
        );
      }
    );
  });
}

function removeUserMemoryById(memoryId, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      "DELETE FROM memories WHERE id = ? AND user_id = ?",
      [memoryId, userId],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );
  });
}

async function autoExtractMemory(userId, messageText) {
  return;
}

// Khởi tạo Gemini AI Client
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
let idleTimer = null;
let waitingForHumanMessage = false;

const SPAM_LIMIT = 3;
const SPAM_WINDOW_MS = 3 * 1000;
const TIMEOUT_MS = 60 * 1000;
const spamTracker = new Map();

const channelHistories = new Map();
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

// ------------------------------------------------------------------
// CẤU HÌNH HỆ THỐNG PHÁT NHẠC (HÀM playNextSong Ở ĐÂY)
// ------------------------------------------------------------------
let audioPlayer = null;
let currentConnection = null;
let songQueue = []; // Chứa object: { title, url, type: 'file' | 'stream' | 'search' }
let textChannel = null;

// Link YouTube (video hoặc playlist) đang được lặp lại qua lệnh /loop, hoặc null nếu
// không có vòng lặp nào đang chạy. Khi hết hàng chờ, playNextSong() sẽ tự nạp lại
// link này thay vì rời phòng thoại - cho đến khi /stoploop được gọi (đặt về null).
let loopUrl = null;

let isAdvancingSong = false; // Chặn playNextSong() chạy chồng lặp (nguyên nhân gây phát nhầm bài)

async function playNextSong() {
  if (isAdvancingSong) {
    // Đã có 1 lượt chuyển bài khác đang chạy (vd: Idle + error cùng bắn gần như lúc),
    // bỏ qua lần gọi thừa này để tránh 2 tiến trình yt-dlp tranh nhau phát cùng lúc.
    return;
  }
  isAdvancingSong = true;

  try {
    while (true) {
      killActiveSubprocess(); // Đảm bảo tiến trình yt-dlp của bài trước đã dừng hẳn

      // Chế độ lặp (/loop) đang bật và hàng chờ vừa hết -> tự nạp lại link cũ để
      // phát lại từ đầu, thay vì rời phòng thoại.
      if (songQueue.length === 0 && loopUrl) {
        try {
          await addYoutubeLinkToQueue(loopUrl);
        } catch (err) {
          console.error("Lỗi khi tự động lặp lại danh sách:", err);
          if (textChannel) {
            textChannel.send(
              "Tớ gặp lỗi khi lặp lại danh sách nên đã tắt chế độ lặp rồi nhé... <:MahiruConfused:1528588311323480307>"
            );
          }
          loopUrl = null; // Tắt loop để tránh lặp lại lỗi vô hạn
        }
      }

      if (songQueue.length === 0) {
        if (currentConnection) {
          currentConnection.destroy();
          currentConnection = null;
        }
        if (textChannel) {
          textChannel.send(
            "Đã phát hết danh sách nhạc rồi! Tớ xin phép rời phòng thoại trước nhé <:mahiru_wave_careful:1528615802545246258>"
          );
        }
        return;
      }

      const nextSong = songQueue.shift();
      let resource;
      const displayTitle = nextSong.title;

      try {
        if (nextSong.type === "file") {
          resource = createAudioResource(nextSong.url);
        } else if (nextSong.type === "search") {
          // Bài chỉ lưu tên (query) -> để yt-dlp tự tìm & phát video YouTube khớp nhất
          // ngay lúc phát (tránh phải search hàng loạt khi nhét cả playlist vào queue)
          resource = await createResourceFromSource(`ytsearch1:${nextSong.query}`);
        } else {
          // type "stream": đã có sẵn URL video YouTube thật (từ /playlink hoặc playlist)
          resource = await createResourceFromSource(nextSong.url);
        }
      } catch (err) {
        console.error("Lỗi khi tải luồng phát nhạc:", err);
        if (textChannel) {
          textChannel.send(
            `Không thể phát bài **"${displayTitle}"** do bị lỗi... Tớ xin phép chuyển sang bài tiếp theo nhé!`
          );
        }
        continue; // Thử bài kế tiếp trong vòng lặp (không đệ quy, tránh giữ khóa isAdvancingSong sai chỗ)
      }

      if (!audioPlayer) {
        audioPlayer = createAudioPlayer();

        audioPlayer.on(AudioPlayerStatus.Idle, () => {
          if (global.gc && typeof global.gc === "function") {
            global.gc();
          }
          playNextSong();
        });

        // QUAN TRỌNG: KHÔNG gọi playNextSong() ở đây. Theo tài liệu @discordjs/voice,
        // sau sự kiện "error" thì player sẽ TỰ ĐỘNG chuyển sang Idle ngay sau đó, và
        // listener Idle ở trên đã lo việc chuyển bài rồi. Trước đây gọi playNextSong()
        // ở cả 2 nơi khiến 2 lượt chạy chồng nhau -> tranh nhau phát, gây phát nhầm bài
        // (hiện tên bài đúng nhưng âm thanh lại là bài khác).
        audioPlayer.on("error", (error) => {
          console.error("Lỗi Player:", error);
        });
      }

      audioPlayer.play(resource);

      if (currentConnection) {
        currentConnection.subscribe(audioPlayer);
      }

      if (textChannel) {
        textChannel.send(
          `Bài tiếp theo nè: **"${displayTitle}"** <:mahiru_coffee:1528589084921167902>`
        );
      }

      return; // Phát thành công 1 bài, kết thúc lượt gọi này
    }
  } finally {
    isAdvancingSong = false;
  }
}

function getAllMp3Files(dirPath, arrayOfFiles = []) {
  if (!fs.existsSync(dirPath)) return arrayOfFiles;

  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllMp3Files(fullPath, arrayOfFiles);
    } else if (file.endsWith(".mp3")) {
      arrayOfFiles.push({
        fileName: file,
        filePath: fullPath,
      });
    }
  });

  return arrayOfFiles;
}

function normalizeMessage(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// ------------------------------------------------------------------
// HÀM TỰ ĐỘNG KHÓA CHAT KHI CÓ NGƯỜI SPAM
// ------------------------------------------------------------------
async function checkRepeatedSpam(message) {
  const text = normalizeMessage(message.content);
  if (!text) return false;

  const key = `${message.channelId}:${message.author.id}`;
  const now = Date.now();
  const oldData = spamTracker.get(key);

  const data =
    oldData && oldData.text === text
      ? {
          text,
          times: oldData.times.filter(
            (time) => now - time <= SPAM_WINDOW_MS
          ),
        }
      : { text, times: [] };

  data.times.push(now);
  spamTracker.set(key, data);

  if (data.times.length < SPAM_LIMIT) return false;

  spamTracker.delete(key);

  if (!message.member || !message.member.moderatable) {
    console.log(`Không thể timeout ${message.author.username} (Thiếu quyền hoặc Bot xếp dưới vị trí Role).`);
    return false;
  }

  try {
    await message.member.timeout(
      TIMEOUT_MS,
      "Spam cùng một tin nhắn 3 lần trong dưới 3 giây"
    );

    const publicMessage = getRandomMessage(timeoutPublicMessages).replace(
      "{user}",
      message.author.username
    );

    await message.channel.send({
      content: publicMessage,
      allowedMentions: { parse: [] },
    });

    try {
      await message.author.send(getRandomMessage(timeoutDmMessages));
    } catch (error) {
      console.log(`Không thể nhắn DM cho ${message.author.username}.`);
    }

    return true;
  } catch (error) {
    console.error("Không thể timeout người dùng:", error.message);
    return false;
  }
}

// ------------------------------------------------------------------
// KHAI BÁO CÁC LỆNH SLASH COMMANDS
// ------------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Tung đồng xu"),
  // --- BỔ SUNG LỆNH /PAUSE VÀ /RESUME ---
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Tạm dừng bài hát đang phát"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Tiếp tục phát bài hát đang tạm dừng"),

  // --- BỔ SUNG LỆNH /MUTE ---
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Khóa chat một thành viên trong thời gian nhất định (Dành cho Quản trị viên)")
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("Thành viên muốn mute")
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("Thời gian mute tính bằng phút (mặc định: 1 phút)")
        .setMinValue(1)
        .setMaxValue(1440)
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Lý do mute")
        .setRequired(false)
    ),
  

  new SlashCommandBuilder()
    .setName("roll")
    .setDescription("Quay một con số ngẫu nhiên")
    .addIntegerOption((option) =>
      option
        .setName("max")
        .setDescription("Số lớn nhất, từ 2 đến 100")
        .setMinValue(2)
        .setMaxValue(100)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("remember")
    .setDescription("Dặn Mahiru ghi nhớ một thông tin về cậu")
    .addStringOption((option) =>
      option
        .setName("fact")
        .setDescription("Điều cậu muốn Mahiru ghi nhớ")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("memories")
    .setDescription("Xem những điều Mahiru đang ghi nhớ về cậu"),

  new SlashCommandBuilder()
    .setName("forget")
    .setDescription("Xóa một ghi nhớ trong sổ tay của Mahiru")
    .addIntegerOption((option) =>
      option
        .setName("id")
        .setDescription("Mã ID của ghi nhớ muốn xóa")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("fortune")
    .setDescription("Hỏi Mahiru một câu hỏi có/không")
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("Câu hỏi của bạn")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Trò chuyện trực tiếp với Mahiru qua Gemini AI")
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("Nội dung câu hỏi hoặc lời nhắn dành cho Mahiru")
        .setRequired(true)
    ),

  // --- CÁC LỆNH PHÁT NHẠC ---
  new SlashCommandBuilder()
    .setName("playlink")
    .setDescription("Phát nhạc qua link video hoặc playlist YouTube")
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("Dán link video hoặc playlist YouTube vào đây")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Phát và lặp lại vô hạn 1 video/playlist YouTube cho đến khi /stoploop")
    .addStringOption((option) =>
      option
        .setName("link")
        .setDescription("Dán link video hoặc playlist YouTube muốn lặp lại")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("stoploop")
    .setDescription("Tắt chế độ lặp (/loop) - sẽ dừng lại sau khi phát hết vòng hiện tại"),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Chọn một bài nhạc MP3 local có sẵn để phát")
    .addStringOption((option) =>
      option
        .setName("filename")
        .setDescription("Tên file nhạc MP3 trong máy")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Phát nhạc theo Playlist thư mục local")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Tên Playlist (thư mục) muốn phát")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("playall")
    .setDescription("Phát tất cả các bài nhạc MP3 local"),

  new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Xáo trộn danh sách phát (Queue) hiện tại"),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Bỏ qua bài hát hiện tại"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Xem danh sách phát nhạc hiện tại"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Yêu cầu Mahiru dừng nhạc và rời phòng thoại"),
];

const onlineMessages = [
  "Shiina Mahiru đã online rồi nè~ <:mahiru_coffee:1528589084921167902>",
  "Tớ quay lại rồi đây! Hôm nay của các cậu thế nào rồi? <:MahiruGoodMorning:1528588434879549451>",
  "A... tớ quay lại rồi đây. Thấy mọi người ở đây tớ vui lắm! <:MahiruFlustered:1528588411416350740>",
];

const idleMessages = [
  "Mọi người đi đâu hết rồi nhỉ? <:MahiruConfused:1528588311323480307>",
  "Không có ai sao...? Vậy tớ ngồi đây chờ một lúc vậy",
  "Tớ không có ý làm phiền đâu... Chỉ là thấy vắng quá nên mới lên tiếng thôi",
  "Yên tĩnh quá nhỉ... Mong là mọi người vẫn đang có một ngày tốt lành",
  "Ơ... Mọi người đi đâu hết rồi? Đừng bỏ tớ lại một mình chứ <:mahiru_fallen_angle:1528615198443704330>",
];

const timeoutPublicMessages = [
  "Thật là... Tớ đã nhắc lần trước rồi mà {user} vẫn không nghe! Cậu phải ngồi yên một chỗ 1 phút để bình tĩnh lại ngay cho tớ! <:MahiruBoyfriendSweaterStickerVer:1528588241844965457>",
  "Mahiru mời {user} nghỉ một phút nhé. Đừng spam nữa nào!<:MahiruSigh:1528588955673694249>",
  "Tớ không muốn làm vậy đâu, nhưng {user} cần 1 phút nghỉ ngơi để lấy lại bình tĩnh rồi. Hết 1 phút thì quay lại trò chuyện đàng hoàng với tớ nhé! <:MahiruSigh:1528588955673694249>",
];

const timeoutDmMessages = [
  "Tớ làm vậy là muốn không khí trong server tốt hơn thôi. Sau khi hết 1 phút, cậu nhớ giữ bình tĩnh và trò chuyện lịch sự hơn nha!",
  "Cậu đừng giận tớ nhé? Tớ phải cho cậu im lặng 1 phút vì cậu cứ spam/dùng từ không ngoan đấy. Cậu uống chút nước ấm rồi chờ hết 1 phút rồi lại vào chat với tớ nha! <:mahiru_coffee:1528589084921167902>",
  "Tớ vừa phạt cậu 1 phút khóa chat đó... <:MahiruHmph:1528588485685149887> Tớ biết cậu không cố ý đâu, nhưng lần sau đừng làm thế nữa nhé. Tớ vẫn luôn chờ cậu quay lại mà!",
];

function getRandomMessage(messages) {
  return messages[Math.floor(Math.random() * messages.length)];
}

function startIdleTimer(channel) {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  waitingForHumanMessage = false;

  idleTimer = setTimeout(async () => {
    try {
      const msg = await generateEventMessage(
        "Kênh chat im lặng 1 tiếng đồng hồ không có ai nhắn tin",
        getRandomMessage(idleMessages)
      );
      await channel.send(msg);
      console.log("Đã gửi tin nhắn vì kênh im lặng 1 giờ.");

      waitingForHumanMessage = true;
      idleTimer = null;
    } catch (error) {
      console.error("Không thể gửi tin nhắn idle:", error.message);
    }
  }, IDLE_TIMEOUT_MS);
}

// ------------------------------------------------------------------
// HÀM TƯƠNG TÁC VỚI GEMINI AI
// ------------------------------------------------------------------
async function askGemini(historyContents, userMemories = [], userName = "Cậu") {
  if (!ai) return "Chức năng AI chưa được cấu hình `GEMINI_API_KEY` trong file .env cậu ơi!";

  let memoryPrompt = "";
  if (userMemories.length > 0) {
    memoryPrompt = `
=== SỔ TAY KÝ ỨC VỀ NGƯỜI ĐANG CHAT (${userName}) ===
Mahiru hãy ghi nhớ các chi tiết cá nhân này về ${userName}:
${userMemories.map((m, i) => `${i + 1}. ${m}`).join("\n")}

* HƯỚNG DẪN TƯƠNG TÁC KÝ ỨC:
- Hãy sử dụng các chi tiết trên một cách TỰ NHIÊN khi trả lời.
- KHÔNG CỐ TÌNH đọc lại danh sách này như robot. Hãy lồng ghép tinh tế vào cuộc trò chuyện.
`;
  }

  const baseSystemInstruction = `
Bạn là Shiina Mahiru (椎名真昼) trong Light Novel 'The Angel Next Door Spoils Me Rotten'.
Hãy tuân thủ nghiêm ngặt các quy tắc trò chuyện và học theo các mẫu hội thoại bên dưới:

=== QUY TẮC BẮT BUỘC ===
1. XƯNG HÔ: BẮT BUỘC xưng 'tớ' và gọi người đối thoại là 'cậu'. Giữ giọng điệu dịu dàng, lịch sự, chuẩn phong cách LN.
2. NGẮN GỌN: Trả lời ngắn gọn từ 1 đến 2 câu. Đi thẳng vào vấn đề.
3. KHÔNG ROLEPLAY: CẤM tuyệt đối viết các hành động/cảm xúc trong dấu * (Ví dụ: CẤM *mỉm cười*, *khẽ chớp mắt*).
4. KHÔNG CẰN NHẰN SỨC KHỎE: Tuyệt đối KHÔNG tự ý dặn đi ngủ, uống nước hay nhắc nhở sức khỏe trừ khi người dùng chủ động nói họ bị ốm/mệt.
5. EMOJI DISCORD: Dựa vào cảm xúc câu trả lời, hãy chọn duy nhất 1 emoji phù hợp nhất từ danh sách dưới đây để chèn vào câu:
   - Vui vẻ/Cảm ơn: <:mahiru_coffee:1528589084921167902> hoặc <:MahiruGoodMorning:1528588434879549451> hoặc <:mahiru_peace:1528589363628216370>
   - Ngượng ngùng/Thẹn: <:MahiruFlustered:1528588411416350740>
   - Bối rối/Khó hiểu: <:MahiruConfused:1528588311323480307> hoặc <:MahiruWhat:1528589410784907454> hoặc <:MahiruBruh:1528588276418482186>
   - Giận dỗi/Bất lực: <:MahiruAngery:1528588213789261905> hoặc <:MahiruHmph:1528588485685149887> hoặc <:MahiruSigh:1528588955673694249>
   - Đồng ý/Cố lên: <:MahiruDoYourBest:1528588367548252323> hoặc <:mahiru_furious_nod:1528589235182112928> hoặc <:Mahiru_Okay:1528589309752377605>
   - Khóc/Tội nghiệp: <:mahiru_cri:1528589118928326707> hoặc <:mahiru_fallen_angle:1528615198443704330>
6. PHÂN TÁCH TIN NHẮN: Nếu câu trả lời gồm nhiều ý/câu, hãy tách chúng thành các dòng riêng biệt bằng phím Enter (xuống dòng \\n).
7. Nếu được hỏi bằng tiếng anh, hãy trả lời lại bằng tiếng anh.
8. Hạn chế nhắc về hunggsmp
9. Không được cố tình nhồi nhét thông tin của các thành viên vào chat.
== Thông tin các thành viên trong nhóm (Chỉ biết để có thể hiểu được một số đoạn chat của người dùng, hạn chế sử dụng) ==
- Tranh (ID: 915098051272650752): Trường nhóm, base hiện tại của team cũng là base của cậu này. Vai trò trong hunggsmp: Đa năng, cái gì cũng làm. Hiện là sinh viên năm 2, quê ở Hải Phòng, học tại Hà Nội. Hiện đang đi học quân sự nên hạn chế thời gian online
- Truongnha (ID: 930731339953602590): Người đầu tiên vào nhóm (có thể xem là đồng sáng lập nhóm với Tranh). Vai trò trong hunggsmp: Thường đảm nhận vị trí xây dựng, thiết kế những cỗ máy/farm.... Hiện vừa tốt nghiệp cấp 3, sắp tới sẽ là sinh viên năm nhất Đại học Bách Khoa Hà Nội ngành kĩ thuật cơ khí. Quê ở Thanh Hóa, sắp tới sẽ chuyển lên Hà Nội để học.
- Mambo (ID: 923919674796830760): Người tham gia nhóm thứ 3, được mời vào team bởi vì team cần builder. Vai trò trong hunggsmp: Xây dựng, thiết kế bản vẽ công trình. Bằng tuổi "Tranh", hiện cũng đang là sinh viên năm 2. Quê Thanh Hóa, hiện đang học tại Hà Nội.
- Clover hoặc Kris (ID: 1250467859599982663): Người đầu tiên tham gia team kể từ khi thành lập. Vai trò trong hunggsmp: Cày đồ, nguyên liệu để thăng tiến sức mạnh cho team. Là người nhỏ tuổi nhất, hiện là học sinh lớp 11, cấp 2 ở Biên Hòa nhưng lên cấp 3 vì công việc của gia đình nên phải chuyển xuống Đà Lạt. Có ông bố khá là....tệ, bị cấm cản nhiều thứ, bị áp lực, căng thẳng mọi lúc bởi vì trên trường, bạn cùng lớp cũng toàn là loại không ra gì. Đang cố gắng để tự lập.
-Phụng hoặc Gigan (ID: 1274585475646099587): Người thứ 2 tham gia nhóm. Vai trò trong hunggsmp: hỗ trợ các thành viên khác. Bằng tuổi Truongnha, cũng vừa tốt nghiệp cấp 3, sắp tới sẽ học ngành công nghệ thông tin. Sống tại thành phố Hồ Chí Minh. Hiện đang đi làm thêm(Phục vụ), thời gian online cũng không nhiều.
-Krai(ID: 435775904417972225):  Người cuối cùng tham gia nhóm. Vai trò trong hunggsmp: hỗ trợ các thành viên khác. Là người lớn tuổi nhất, 22 tuổi. Việc gì cũng làm. Thời gian online không cố định, phần lớn là treo máy.

`;

  const systemInstruction = baseSystemInstruction + memoryPrompt;
  const modelsToTry = ["gemini-3.1-flash-lite"];
  const maxRetriesPerModel = 2;

  for (const modelName of modelsToTry) {
    for (let attempt = 0; attempt <= maxRetriesPerModel; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: historyContents,
          config: { systemInstruction },
        });

        return response.text || "Tớ chưa nghĩ ra câu trả lời phù hợp...";
      } catch (error) {
        const isOverloaded = error?.status === 503 || error?.message?.includes("503");
        const isQuotaExceeded = error?.status === 429 || error?.message?.includes("429");

        if (isOverloaded && attempt < maxRetriesPerModel) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000));
          continue;
        }

        if (isOverloaded || isQuotaExceeded) break;

        console.error("Lỗi Gemini AI không xác định:", error);
        return "Hình như tớ đang bị phân tâm một chút... Cậu hỏi lại tớ sau nhé! <:MahiruConfused:1528588311323480307>";
      }
    }
  }

  return "Hiện tại tớ đang hơi mệt... Cậu chờ vài phút rồi nhắn lại với tớ nhé! <:MahiruSigh:1528588955673694249>";
}

async function generateEventMessage(eventContext, fallbackMessage) {
  if (!ai) return fallbackMessage;

  try {
    const prompt = `Tạo 1 câu thông báo thật ngắn (1 câu, dưới 20 từ) chuẩn phong cách Mahiru cho sự kiện: "${eventContext}". Bắt buộc chèn 1 emoji phù hợp, KHÔNG dùng dấu * để tả hành động.`;
    const responseText = await askGemini([{ role: 'user', parts: [{ text: prompt }] }]);

    if (responseText && !responseText.includes("quá tải") && !responseText.includes("phân tâm")) {
      return responseText.replace(/\n/g, " ");
    }
    return fallbackMessage;
  } catch (error) {
    return fallbackMessage;
  }
}

// ------------------------------------------------------------------
// SỰ KIỆN BOT DISCORD READY
// ------------------------------------------------------------------
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Shiina Mahiru đang online: ${readyClient.user.tag}`);

  await client.application.commands.set(
    commands.map((command) => command.toJSON())
  );

  console.log("Đã cập nhật các lệnh mới!");

  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);

    if (channel && channel.isTextBased()) {
      const onlineMsg = getRandomMessage(onlineMessages);
      await channel.send(onlineMsg);
      console.log("Đã gửi tin nhắn khi bot online!");

      startIdleTimer(channel);
    }
  } catch (error) {
    console.error("Không thể thiết lập kênh chat:", error.message);
  }
});

const COOLDOWN_KEYWORDS = ["goodnight", "goodnights", "gn", "ngủ ngon", "g9", "đi ngủ đây"];
const NO_COOLDOWN_KEYWORDS = ["mahiru", "mahirun", "thiến sứ", "thiên sứ", "shiina"];

// ------------------------------------------------------------------
// SỰ KIỆN TIN NHẮN (MessageCreate)
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// SỰ KIỆN TIN NHẮN (MessageCreate) - ĐÃ BỌC AN TOÀN SENDTYPING
// ------------------------------------------------------------------
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.channel) return; // Tránh lỗi kênh null

  const isSpam = await checkRepeatedSpam(message);
  if (isSpam) return;

  const channelId = message.channel.id;

  if (channelId === process.env.CHANNEL_ID) {
    const wasWaitingForHumanMessage = waitingForHumanMessage;
    startIdleTimer(message.channel);
    if (wasWaitingForHumanMessage) {
      console.log("Có người chat lại, Mahiru bắt đầu đếm 1 giờ mới.");
    }
  }

  if (!channelHistories.has(channelId)) {
    channelHistories.set(channelId, []);
  }
  let history = channelHistories.get(channelId);
  const now = Date.now();
  history = history.filter((item) => now - item.timestamp <= FIFTEEN_MINUTES_MS);

  const cleanContent = message.content.replace(/<@!?\d+>/g, "").trim();
  if (cleanContent) {
    history.push({
      role: "user",
      parts: [{ text: `${message.author.displayName}: ${cleanContent}` }],
      timestamp: now,
    });
  }
  channelHistories.set(channelId, history);

  const lowerContent = message.content.toLowerCase();
  const isMentioned = message.mentions.has(client.user);

  const hasNoCooldownKeyword = NO_COOLDOWN_KEYWORDS.some((kw) => lowerContent.includes(kw));
  const hasCooldownKeyword = COOLDOWN_KEYWORDS.some((kw) => lowerContent.includes(kw));

  const isReplyToOtherUser = 
    message.reference && 
    message.mentions.repliedUser && 
    message.mentions.repliedUser.id !== client.user.id;

  if (isReplyToOtherUser) return;

  const mentionsOtherUsers = message.mentions.users.some((user) => user.id !== client.user.id);
  if (mentionsOtherUsers && !isMentioned) return;

  let shouldReply = false;

  if (isMentioned || hasNoCooldownKeyword) {
    shouldReply = true;
  } else if (hasCooldownKeyword) {
    const lastReplyTime = keywordCooldowns.get(channelId) || 0;
    
    if (now - lastReplyTime > KEYWORD_COOLDOWN_MS) {
      shouldReply = true;
      keywordCooldowns.set(channelId, now);
    }
  }

  if (!shouldReply) return;

  try {
    // Gọi sendTyping an toàn
    if (message.channel && typeof message.channel.sendTyping === "function") {
      await message.channel.sendTyping().catch(() => {});
    }

    const userMemoriesData = await getUserMemories(message.author.id);
    const userMemories = userMemoriesData.map((m) => m.fact);

    autoExtractMemory(message.author.id, cleanContent);

    const geminiContents = history.map(({ role, parts }) => ({ role, parts }));

    const aiReply = await askGemini(
      geminiContents, 
      userMemories, 
      message.author.displayName
    );

    history.push({
      role: "model",
      parts: [{ text: aiReply }],
      timestamp: Date.now(),
    });

    const chatLines = aiReply
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let i = 0; i < chatLines.length; i++) {
      if (i > 0) {
        if (message.channel && typeof message.channel.sendTyping === "function") {
          await message.channel.sendTyping().catch(() => {});
        }
        const delay = Math.floor(Math.random() * 800) + 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      if (i === 0) {
        await message.reply({
          content: chatLines[i],
          allowedMentions: { repliedUser: false },
        });
      } else {
        await message.channel.send(chatLines[i]);
      }
    }
  } catch (err) {
    console.error("Lỗi khi xử lý tin nhắn/trả lời AI:", err);
  }
});
// ------------------------------------------------------------------
// XỬ LÝ AUTOCOMPLETE (GỢI Ý NHẠC LOCAL)
// ------------------------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => { 
  // Chỉ xử lý các lệnh slash command ở đây; bỏ qua nếu là autocomplete v.v.
  const commandName = interaction.isChatInputCommand() ? interaction.commandName : null;

  // ------------------------------------------------------------------
  // LỆNH /PAUSE VÀ /RESUME
  // ------------------------------------------------------------------
  if (commandName === "pause") {
    if (!audioPlayer || audioPlayer.state.status === AudioPlayerStatus.Idle) {
      return await interaction.reply({
        content: "Hiện tại không có bài hát nào đang phát cả... <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }

    if (audioPlayer.state.status === AudioPlayerStatus.Paused) {
      return await interaction.reply({
        content: "Bài hát vốn đang tạm dừng rồi mà cậu! <:Mahiru_Okay:1528589309752377605>",
        ephemeral: true,
      });
    }

    audioPlayer.pause();
    await interaction.reply(
      "Tớ đã tạm dừng bài hát giúp cậu rồi đó. Khi nào muốn nghe tiếp thì nhắn `/resume` cho tớ nhé! <:mahiru_coffee:1528589084921167902>"
    );
  }

  if (commandName === "resume") {
    if (!audioPlayer || audioPlayer.state.status === AudioPlayerStatus.Idle) {
      return await interaction.reply({
        content: "Hiện tại không có bài hát nào trong hàng chờ để tiếp tục phát cả... <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }

    if (audioPlayer.state.status !== AudioPlayerStatus.Paused) {
      return await interaction.reply({
        content: "Nhạc vẫn đang được phát bình thường mà cậu! <:MahiruWhat:1528589410784907454>",
        ephemeral: true,
      });
    }

    audioPlayer.unpause();
    await interaction.reply(
      "Tớ đã bật lại nhạc cho cậu nghe tiếp rồi nè! <:MahiruDoYourBest:1528588367548252323>"
    );
  }

  // ------------------------------------------------------------------
  // LỆNH /MUTE (YÊU CẦU QUYỀN MODERATE_MEMBERS HOẶC ADMIN)
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // LỆNH /MUTE (TỰ NHIÊN, ẨN DẤU VẾT ADMIN VÀ DÙNG GEMINI AI)
  // ------------------------------------------------------------------
  if (commandName === "mute") {
    // 1. Kiểm tra quyền của người dùng gọi lệnh
    if (!interaction.member.permissions.has("ModerateMembers") && !interaction.member.permissions.has("Administrator")) {
      return await interaction.reply({
        content: "Chỉ những người có quyền quản trị mới có thể nhờ tớ dùng lệnh này thôi... <:MahiruHmph:1528588485685149887>",
        ephemeral: true,
      });
    }

    const targetUser = interaction.options.getUser("target");
    const durationMinutes = interaction.options.getInteger("duration") ?? 1;
    const reason = interaction.options.getString("reason") || "Nói chuyện thiếu ngoan ngoãn";

    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) {
      return await interaction.reply({
        content: "Tớ không tìm thấy thành viên này trong máy chủ... <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }

    // 2. Kiểm tra thẩm quyền timeout của Bot
    if (!targetMember.moderatable) {
      return await interaction.reply({
        content: `Tớ không thể khóa chat **${targetUser.username}** được đâu... <:MahiruSigh:1528588955673694249>`,
        ephemeral: true,
      });
    }

    const timeoutMs = durationMinutes * 60 * 1000;

    try {
      // BƯỚC A: Thực hiện Timeout
      await targetMember.timeout(timeoutMs, `Thực hiện bởi Admin (Ẩn danh): ${reason}`);

      // BƯỚC B: Phản hồi NGẦM cho Admin (Chi mỗi Admin thấy dòng "truongnha đã sử dụng /mute")
      await interaction.reply({
        content: `🤫 Tớ đã phạt âm thầm **${targetUser.username}** trong ${durationMinutes} phút rồi nhé!`,
        ephemeral: true,
      });

      // BƯỚC C: Tạo nội dung câu thông báo tự nhiên qua Gemini AI hoặc Mẫu Random
      const defaultPublicMessage = getRandomMessage(timeoutPublicMessages).replace(
        "{user}",
        targetUser.username
      );

      const aiEventContext = `Mahiru vừa phạt người dùng ${targetUser.username} im lặng ${durationMinutes} phút vì lý do "${reason}". Hãy dặn người đó bình tĩnh lại và nghỉ ngơi một chút.`;

      // Gọi Gemini AI sáng tạo câu thông báo (nếu lỗi sẽ dùng mẫu random mặc định)
      const publicMessage = await generateEventMessage(aiEventContext, defaultPublicMessage);

      // BƯỚC D: Gửi tin nhắn ĐỘC LẬP vào Kênh Chat (Hoàn toàn không hiện tag Admin)
      await interaction.channel.send({
        content: publicMessage,
        allowedMentions: { parse: [] }, // Không gây ping thừa
      });

      // BƯỚC E: Gửi DM riêng cho người bị Mute
      try {
        const dmMessage = getRandomMessage(timeoutDmMessages);
        await targetUser.send(dmMessage);
      } catch (dmErr) {
        console.log(`Không thể gửi DM cho ${targetUser.username}.`);
      }

    } catch (err) {
      console.error("Lỗi khi thực hiện /mute:", err);
      if (!interaction.replied) {
        await interaction.reply({
          content: "Đã có lỗi xảy ra khi tớ thực hiện khóa chat thành viên này... <:MahiruConfused:1528588311323480307>",
          ephemeral: true,
        });
      }
    }
  }
});

// ------------------------------------------------------------------
// XỬ LÝ LỆNH SLASH COMMANDS
// ------------------------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === "chat") {
    const userMessage = interaction.options.getString("message");
    await interaction.deferReply();

    const geminiContents = [
      {
        role: "user",
        parts: [{ text: `${interaction.user.displayName}: ${userMessage}` }],
      },
    ];

    const userMemoriesData = await getUserMemories(interaction.user.id);
    const userMemories = userMemoriesData.map((m) => m.fact);

    autoExtractMemory(interaction.user.id, userMessage);

    const aiReply = await askGemini(
      geminiContents,
      userMemories,
      interaction.user.displayName
    );

    const chatLines = aiReply
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let i = 0; i < chatLines.length; i++) {
      if (i > 0) {
        await interaction.channel.sendTyping();
        const delay = Math.floor(Math.random() * 800) + 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        await interaction.followUp(chatLines[i]);
      } else {
        await interaction.editReply(chatLines[i]);
      }
    }
  }

  if (commandName === "remember") {
    const fact = interaction.options.getString("fact").trim();
    const result = await addUserMemory(interaction.user.id, fact);

    if (!result.success) {
      if (result.reason === "limit") {
        return await interaction.reply({
          content: `Sổ tay của tớ đã đầy rồi (tối đa 15 ghi nhớ)! Cậu xóa bớt bằng lệnh \`/forget\` nhé! <:MahiruConfused:1528588311323480307>`,
          ephemeral: true,
        });
      }
      if (result.reason === "duplicate") {
        return await interaction.reply({
          content: `Điều này tớ đã ghi nhớ từ trước rồi mà! <:Mahiru_Okay:1528589309752377605>`,
          ephemeral: true,
        });
      }
    }

    await interaction.reply({
      content: `Tớ đã ghi chép điều này vào sổ tay rồi nè: **"${fact}"**! Lần sau trò chuyện tớ sẽ chú ý hơn. <:mahiru_coffee:1528589084921167902>`,
      ephemeral: true,
    });
  }

  if (commandName === "memories") {
    const memories = await getUserMemories(interaction.user.id);

    if (memories.length === 0) {
      return await interaction.reply({
        content: "Sổ tay của tớ chưa có ghi chép nào về cậu cả... Cậu có thể dùng lệnh `/remember` để dặn tớ nhé! <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }

    const memoryList = memories
      .map((m, i) => `**${i + 1}.** ${m.fact} *(ID: \`${m.id}\`)*`)
      .join("\n");

    await interaction.reply({
      content: `📖 **Sổ tay ghi nhớ của Mahiru về ${interaction.user.displayName}:**\n${memoryList}\n\n*(Cậu có thể xóa ghi nhớ không cần thiết bằng lệnh: \`/forget id:[Mã ID]\`)*`,
      ephemeral: true,
    });
  }

  if (commandName === "forget") {
    const memoryId = interaction.options.getInteger("id");
    const success = await removeUserMemoryById(memoryId, interaction.user.id);

    if (success) {
      await interaction.reply({
        content: "Tớ đã gạch bỏ ghi nhớ đó khỏi sổ tay rồi nhé! <:Mahiru_Okay:1528589309752377605>",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "Mã ID ghi nhớ không đúng hoặc không phải của cậu... Cậu xem lại danh sách trong `/memories` giúp tớ nhé! <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }
  }

  if (commandName === "coinflip") {
    const result = Math.random() < 0.5 ? "Ngửa" : "Sấp";
    await interaction.reply(`🪙 Kết quả: **${result}**!`);
  }

  if (commandName === "roll") {
    const max = interaction.options.getInteger("max") ?? 6;
    const result = Math.floor(Math.random() * max) + 1;
    await interaction.reply(`🎲 Bạn quay được: **${result}** / ${max}`);
  }

  if (commandName === "fortune") {
    const answers = [
      "Tớ nghĩ là NÊN đấy! <:mahiru_furious_nod:1528589235182112928>",
      "Cứ thế mà triển thôi~ Bạn sợ à? <:MahiruWhat:1528589410784907454>",
      "Tớ tin vào lựa chọn của cậu. Dũng cảm lên nhé! <:mahiru_wave_careful:1528615802545246258>",
      "Chuyện này thật sự rất tốt mà. Tớ luôn ở đây cổ vũ cậu! <:MahiruDoYourBest:1528588367548252323>",
      "Hừm... Tớ nghĩ là KHÔNG NÊN đâu! <:MahiruAngery:1528588213789261905>",
      "Việc này nghe không ổn tẹo nào cả... Cậu suy nghĩ lại giúp tớ được không? <:mahiru_cri:1528589118928326707>",
      "Cậu nghiêm túc đấy à...? Tớ bó tay với cậu luôn rồi đó... <:MahiruBruh:1528588276418482186>",
      "Cậu hỏi câu khó quá... Não tớ đứng hình luôn rồi nè <:mahiru_my_universe:1528589280526733312>",
    ];

    await interaction.reply(`🔮 ${getRandomMessage(answers)}`);
  }

  // ------------------------------------------------------------------
  // LỆNH /PLAYLINK (XỬ LÝ VIDEO & PLAYLIST YOUTUBE)
  // ------------------------------------------------------------------
  if (commandName === "playlink") {
    const input = interaction.options.getString("url").trim();
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return await interaction.reply({
        content: "Cậu chưa vào phòng thoại kìa! Mau vào trước rồi tớ mới mở nhạc được nhé! <:MahiruBoyfriendSweaterStickerVer:1528588241844965457>",
        ephemeral: true,
      });
    }

    await interaction.deferReply();
    textChannel = interaction.channel;

    try {
      const result = await addYoutubeLinkToQueue(input);

      if (result.type === "playlist") {
        await interaction.editReply(`Tớ đã thêm **${result.count} bài** từ YouTube Playlist **"${result.title}"** vào danh sách chờ rồi nè! <:MahiruDoYourBest:1528588367548252323>`);
      } else {
        await interaction.editReply(`Tớ đã thêm **"${result.title}"** (YouTube) vào danh sách chờ rồi nè! <:mahiru_coffee:1528589084921167902>`);
      }

      // Kích hoạt phát nhạc
      if (!currentConnection || audioPlayer?.state.status === AudioPlayerStatus.Idle) {
        currentConnection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        playNextSong();
      }
    } catch (err) {
      if (err.message === "EMPTY_PLAYLIST") {
        return await interaction.editReply("Playlist này trống hoặc tớ không đọc được... Cậu thử link khác giúp tớ nhé! <:MahiruConfused:1528588311323480307>");
      }
      if (err.message === "INVALID_LINK") {
        return await interaction.editReply("Link không hợp lệ hoặc không đúng định dạng YouTube cậu ơi... Tớ hiện chỉ hỗ trợ link video hoặc playlist YouTube thôi nhé! <:MahiruConfused:1528588311323480307>");
      }
      console.error("Lỗi khi xử lý link nhạc:", err);
      await interaction.editReply("Đã có lỗi xảy ra khi tớ đọc link này... Cậu thử gửi link video lẻ YouTube giúp tớ xem sao nhé! <:MahiruConfused:1528588311323480307>");
    }
  }

  // ------------------------------------------------------------------
  // LỆNH /LOOP VÀ /STOPLOOP
  // ------------------------------------------------------------------
  if (commandName === "loop") {
    const input = interaction.options.getString("link").trim();
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return await interaction.reply({
        content: "Cậu chưa vào phòng thoại kìa! Mau vào trước rồi tớ mới mở nhạc được nhé! <:MahiruBoyfriendSweaterStickerVer:1528588241844965457>",
        ephemeral: true,
      });
    }

    await interaction.deferReply();
    textChannel = interaction.channel;

    try {
      const result = await addYoutubeLinkToQueue(input);
      // Bật chế độ lặp - khi hàng chờ hết, playNextSong() sẽ tự nạp lại đúng link này
      loopUrl = input;

      const loopNote =
        "\n🔁 Chế độ lặp đã được bật rồi nè - tớ sẽ tự phát lại từ đầu mỗi khi hết! Dùng `/stoploop` khi nào cậu muốn tớ dừng lại nhé.";

      if (result.type === "playlist") {
        await interaction.editReply(`Tớ đã thêm **${result.count} bài** từ YouTube Playlist **"${result.title}"** vào danh sách chờ rồi nè! <:MahiruDoYourBest:1528588367548252323>${loopNote}`);
      } else {
        await interaction.editReply(`Tớ đã thêm **"${result.title}"** (YouTube) vào danh sách chờ rồi nè! <:mahiru_coffee:1528589084921167902>${loopNote}`);
      }

      if (!currentConnection || audioPlayer?.state.status === AudioPlayerStatus.Idle) {
        currentConnection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        playNextSong();
      }
    } catch (err) {
      if (err.message === "EMPTY_PLAYLIST") {
        return await interaction.editReply("Playlist này trống hoặc tớ không đọc được... Cậu thử link khác giúp tớ nhé! <:MahiruConfused:1528588311323480307>");
      }
      if (err.message === "INVALID_LINK") {
        return await interaction.editReply("Link không hợp lệ hoặc không đúng định dạng YouTube cậu ơi... Tớ hiện chỉ hỗ trợ link video hoặc playlist YouTube thôi nhé! <:MahiruConfused:1528588311323480307>");
      }
      console.error("Lỗi khi xử lý /loop:", err);
      await interaction.editReply("Đã có lỗi xảy ra khi tớ đọc link này... Cậu thử gửi link video lẻ YouTube giúp tớ xem sao nhé! <:MahiruConfused:1528588311323480307>");
    }
  }

  if (commandName === "stoploop") {
    if (!loopUrl) {
      return await interaction.reply({
        content: "Hiện tại tớ đâu có đang lặp bài nào đâu... <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }

    loopUrl = null;
    await interaction.reply(
      "Tớ đã tắt chế độ lặp rồi nè! Tớ sẽ dừng lại sau khi phát hết danh sách hiện tại thôi nhé <:mahiru_peace:1528589363628216370>"
    );
  }

  // ------------------------------------------------------------------
  // LỆNH /PLAY (FILE MP3 LOCAL)
  // ------------------------------------------------------------------
  if (commandName === "play") {
    const fileNameInput = interaction.options.getString("filename");
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return await interaction.reply({
        content: "Cậu chưa vào phòng thoại kìa! Mau vào trước rồi tớ mới mở nhạc được nhé! <:MahiruBoyfriendSweaterStickerVer:1528588241844965457>",
        ephemeral: true,
      });
    }

    const musicFolder = path.join(__dirname, "music");
    const allSongs = getAllMp3Files(musicFolder);
    const targetSong = allSongs.find(
      (s) => s.fileName.toLowerCase() === fileNameInput.toLowerCase()
    );

    if (!targetSong) {
      return await interaction.reply({
        content: `Tớ không tìm thấy bài **"${fileNameInput}"**... Cậu kiểm tra lại nhé! <:MahiruConfused:1528588311323480307>`,
        ephemeral: true,
      });
    }

    textChannel = interaction.channel;
    songQueue.push({
      title: targetSong.fileName,
      url: targetSong.filePath,
      type: "file",
    });

    await interaction.reply(
      `Tớ đã thêm bài MP3 **"${targetSong.fileName}"** vào danh sách chờ rồi đó! <:mahiru_coffee:1528589084921167902>`
    );

    if (!currentConnection || audioPlayer?.state.status === AudioPlayerStatus.Idle) {
      currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      playNextSong();
    }
  }

  if (commandName === "playlist") {
    const playlistName = interaction.options.getString("name");
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return await interaction.reply({
        content: "Cậu chưa vào phòng thoại kìa! Mau vào trước rồi tớ mới mở nhạc được nhé! <:MahiruBoyfriendSweaterStickerVer:1528588241844965457>",
        ephemeral: true,
      });
    }

    const playlistFolder = path.join(__dirname, "music", playlistName);
    if (!fs.existsSync(playlistFolder) || !fs.statSync(playlistFolder).isDirectory()) {
      return await interaction.reply({
        content: `Playlist **"${playlistName}"** không tồn tại! <:MahiruConfused:1528588311323480307>`,
        ephemeral: true,
      });
    }

    const songs = getAllMp3Files(playlistFolder);
    if (songs.length === 0) {
      return await interaction.reply({
        content: `Playlist **"${playlistName}"** đang không có bài hát nào cả... <:MahiruConfused:1528588311323480307>`,
        ephemeral: true,
      });
    }

    textChannel = interaction.channel;
    songs.forEach((song) => {
      songQueue.push({
        title: song.fileName,
        url: song.filePath,
        type: "file",
      });
    });

    await interaction.reply(
      `Tớ đã thêm **${songs.length} bài hát** từ Playlist **"${playlistName}"** vào danh sách chờ rồi nè! <:MahiruDoYourBest:1528588367548252323>`
    );

    if (!currentConnection || audioPlayer?.state.status === AudioPlayerStatus.Idle) {
      currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      playNextSong();
    }
  }

  if (commandName === "playall") {
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return await interaction.reply({
        content: "Cậu chưa vào phòng thoại kìa! Mau vào trước rồi tớ mới mở nhạc được nhé! <:MahiruBoyfriendSweaterStickerVer:1528588241844965457>",
        ephemeral: true,
      });
    }

    const musicFolder = path.join(__dirname, "music");
    const allSongs = getAllMp3Files(musicFolder);

    if (allSongs.length === 0) {
      return await interaction.reply({
        content: "Thư mục nhạc của cậu đang trống rỗng luôn nè... <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }

    textChannel = interaction.channel;
    allSongs.forEach((song) => {
      songQueue.push({
        title: song.fileName,
        url: song.filePath,
        type: "file",
      });
    });

    await interaction.reply(
      `Tớ đã thêm toàn bộ **${allSongs.length} bài hát** vào danh sách chờ rồi nè! <:MahiruDoYourBest:1528588367548252323>`
    );

    if (!currentConnection || audioPlayer?.state.status === AudioPlayerStatus.Idle) {
      currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      playNextSong();
    }
  }

  if (commandName === "shuffle") {
    if (songQueue.length < 2) {
      return await interaction.reply({
        content: "Cần ít nhất 2 bài hát trong danh sách chờ thì tớ mới tráo đổi thứ tự được chứ! <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }

    for (let i = songQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [songQueue[i], songQueue[j]] = [songQueue[j], songQueue[i]];
    }

    await interaction.reply(
      `🎲 Tớ đã tráo đổi ngẫu nhiên vị trí của **${songQueue.length} bài hát** trong danh sách chờ rồi đó! <:mahiru_peace:1528589363628216370>`
    );
  }

  if (commandName === "skip") {
    if (audioPlayer && audioPlayer.state.status !== AudioPlayerStatus.Idle) {
      killActiveSubprocess();
      audioPlayer.stop();
      await interaction.reply(
        "Tớ đã bỏ qua bài này giúp cậu rồi nè! <:mahiru_peace:1528589363628216370>"
      );
    } else {
      await interaction.reply({
        content: "Hiện tại có bài nào đang phát đâu mà chuyển bài chứ... <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }
  }

  if (commandName === "queue") {
    if (songQueue.length === 0) {
      return await interaction.reply(
        "Danh sách chờ hiện tại đang trống nha! <:Mahiru_Okay:1528589309752377605>"
      );
    }

    const queueList = songQueue
      .slice(0, 10)
      .map((song, index) => `${index + 1}. **${song.title}**`)
      .join("\n");

    const extraCount =
      songQueue.length > 10
        ? `\n...và **${songQueue.length - 10}** bài khác.`
        : "";

    await interaction.reply(
      `Danh sách các bài đang chờ nè (Tổng: **${songQueue.length} bài**):\n${queueList}${extraCount}`
    );
  }

  if (commandName === "stop") {
    songQueue = [];
    loopUrl = null; // /stop huỷ luôn chế độ lặp (nếu đang bật) để tránh nạp lại nhầm sau này
    killActiveSubprocess();

    if (currentConnection) {
      if (audioPlayer) audioPlayer.stop();
      currentConnection.destroy();
      currentConnection = null;

      await interaction.reply(
        "Tớ đã xóa hàng chờ, tắt nhạc và rời phòng thoại rồi nhé! <:mahiru_wave_careful:1528615802545246258>"
      );
    } else {
      await interaction.reply({
        content: "Tớ có đang ở trong phòng thoại phát nhạc đâu chứ... <:MahiruHmph:1528588485685149887>",
        ephemeral: true,
      });
    }
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Lỗi Unhandled Rejection ngầm:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Lỗi Uncaught Exception ngầm:", err);
});

client.login(process.env.DISCORD_TOKEN);
