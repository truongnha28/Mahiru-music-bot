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
} = require("@discordjs/voice");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
let idleTimer = null;
let waitingForHumanMessage = false;
const SPAM_LIMIT = 3;
const SPAM_WINDOW_MS = 3 * 1000;
const TIMEOUT_MS = 60 * 1000;
const spamTracker = new Map();

// ------------------------------------------------------------------
// CẤU HÌNH HỆ THỐNG PHÁT NHẠC (QUEUE)
// ------------------------------------------------------------------
let audioPlayer = null;
let currentConnection = null;
let songQueue = [];
let textChannel = null;

function playNextSong() {
  if (songQueue.length === 0) {
    if (currentConnection) {
      currentConnection.destroy();
      currentConnection = null;
    }
    if (textChannel) {
      textChannel.send("Đã phát hết danh sách nhạc rồi! Tớ xin phép rời phòng thoại trước nhé <:mahiru_wave_careful:1528615802545246258>");
    }
    return;
  }

  const nextSong = songQueue.shift();
  const resource = createAudioResource(nextSong.filePath);

  if (!audioPlayer) {
    audioPlayer = createAudioPlayer();

    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      playNextSong();
    });

    audioPlayer.on("error", (error) => {
      console.error("Lỗi Player:", error);
      playNextSong();
    });
  }

  audioPlayer.play(resource);

  if (currentConnection) {
    currentConnection.subscribe(audioPlayer);
  }

  if (textChannel) {
    textChannel.send(`Bài tiếp theo nè: **"${nextSong.fileName}"** <:mahiru_coffee:1528589084921167902>`);
  }
}

// Hàm quét tất cả các file mp3 trong thư mục (bao gồm cả thư mục con)
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
    console.log(`Không thể timeout ${message.author.username}.`);
    return false;
  }

  try {
    await message.member.timeout(
      TIMEOUT_MS,
      "Spam cùng một tin nhắn nhiều lần"
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
    .setName("fortune")
    .setDescription("Hỏi Mahiru một câu hỏi có/không")
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("Câu hỏi của bạn")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Chọn một bài nhạc MP3 cụ thể để phát")
    .addStringOption((option) =>
      option
        .setName("filename")
        .setDescription("Tên file nhạc MP3")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Phát nhạc theo Playlist (Thư mục con)")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Tên Playlist (thư mục) muốn phát")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("playall")
    .setDescription("Phát tất cả các bài nhạc có trong tất cả Playlist"),

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
  "Không có ai sao...? Vậy tôi ngồi đây chờ một lúc vậy",
  "Tớ không có ý làm phiền đâu... Chỉ là thấy vắng quá nên mới lên tiếng thôi",
  "Yên tĩnh quá nhỉ... Mong là mọi người vẫn đang có một ngày tốt lành",
  "Ơ... Mọi người đi đâu hết rồi? Đừng bỏ tớ lại một mình chứ <:mahiru_fallen_angle:1528615198443704330>",
  "Đừng thức khuya quá đấy... Sức khỏe là quan trọng nhất mà",
  "Nhớ chớp mắt và vươn vai một chút nhé, ngồi máy tính lâu không tốt đâu",
  "Kênh chat yên tĩnh quá nhỉ... Các cậu đã uống nước hay nghỉ tay một chút chưa?",
  "Yên tĩnh thế này cũng thích thật... Mong là các cậu đang có một ngày thật dịu dàng và bình yên",
  "Mấy giờ rồi nhỉ...? Các cậu nhớ chú ý thời gian nghỉ ngơi nha! <:mahiru_time:1528615635654017105>",
];

const timeoutPublicMessages = [
  "Thật là... Tớ đã nhắc lần trước rồi mà <@user> vẫn không nghe! Cậu phải ngồi yên một chỗ 1 phút để bình tĩnh lại ngay cho tớ! <:MahiruBoyfriendSweaterStickerVer:1528588241844965457>",
  "Mahiru mời {user} nghỉ một phút nhé. Đừng spam nữa nào!<:MahiruSigh:1528588955673694249>",
  "Tớ không muốn làm vậy đâu, nhưng <@user> cần 1 phút nghỉ ngơi để lấy lại bình tĩnh rồi. Hết 1 phút thì quay lại trò chuyện đàng hoàng với tớ nhé! <:MahiruSigh:1528588955673694249>",
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
      await channel.send(getRandomMessage(idleMessages));
      console.log("Đã gửi tin nhắn vì kênh im lặng 1 giờ.");

      waitingForHumanMessage = true;
      idleTimer = null;
    } catch (error) {
      console.error("Không thể gửi tin nhắn idle:", error.message);
    }
  }, IDLE_TIMEOUT_MS);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Shiina Mahiru đang online: ${readyClient.user.tag}`);

  await client.application.commands.set(
    commands.map((command) => command.toJSON())
  );

  console.log("Đã cập nhật các lệnh mới!");

  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);

    if (channel && channel.isTextBased()) {
      await channel.send(getRandomMessage(onlineMessages));
      console.log("Đã gửi tin nhắn khi bot online!");

      startIdleTimer(channel);
    } else {
      console.log("Không tìm thấy kênh để gửi tin nhắn.");
    }
  } catch (error) {
    console.error("Không thể thiết lập kênh chat:", error.message);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.mentions.has(client.user)) {
    const replies = [
      "Tớ vẫn ở đây nè~ <:mahiru_coffee:1528589084921167902>",
      "Tớ có thể giúp gì cho cậu? <:MahiruConfused:1528588311323480307>",
      "Gọi ít thôi! Tớ giận thật đấy <:MahiruAngery:1528588213789261905>",
    ];

    await message.reply({
      content: getRandomMessage(replies),
      allowedMentions: { repliedUser: false },
    });
  }

  if (message.channelId !== process.env.CHANNEL_ID) return;

  if (await checkRepeatedSpam(message)) return;

  const wasWaitingForHumanMessage = waitingForHumanMessage;
  startIdleTimer(message.channel);

  if (wasWaitingForHumanMessage) {
    console.log("Có người chat lại, Mahiru bắt đầu đếm 1 giờ mới.");
  }
});

// ------------------------------------------------------------------
// XỬ LÝ AUTOCOMPLETE (GỢI Ý TÊN BÀI HÁT & PLAYLIST)
// ------------------------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const musicFolder = path.join(__dirname, "music");
    if (!fs.existsSync(musicFolder)) return await interaction.respond([]);

    // Gợi ý cho /play (Tên file)
    if (interaction.commandName === "play") {
      const focusedValue = interaction.options.getFocused().toLowerCase();
      const allSongs = getAllMp3Files(musicFolder);
      const filtered = allSongs.filter((song) =>
        song.fileName.toLowerCase().includes(focusedValue)
      );

      await interaction.respond(
        filtered.slice(0, 25).map((song) => ({
          name: song.fileName,
          value: song.fileName,
        }))
      );
    }

    // Gợi ý cho /playlist (Tên thư mục con)
    if (interaction.commandName === "playlist") {
      const focusedValue = interaction.options.getFocused().toLowerCase();
      const items = fs.readdirSync(musicFolder);

      const playlists = items.filter((item) =>
        fs.statSync(path.join(musicFolder, item)).isDirectory()
      );

      const filtered = playlists.filter((pl) =>
        pl.toLowerCase().includes(focusedValue)
      );

      await interaction.respond(
        filtered.slice(0, 25).map((pl) => ({ name: pl, value: pl }))
      );
    }
  }
});

// ------------------------------------------------------------------
// XỬ LÝ LỆNH SLASH COMMANDS
// ------------------------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

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

  // --- LỆNH PHÁT 1 BÀI HÁT (/play) ---
  if (commandName === "play") {
    const fileNameInput = interaction.options.getString("filename");
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return await interaction.reply({
        content: "Cậu chưa vào phòng thoại (Voice Channel) kìa! Mau vào trước rồi tớ mới mở nhạc cho nghe được nhé! <:MahiruBoyfriendSweaterStickerVer:1528588241844965457>",
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
    songQueue.push(targetSong);
    await interaction.reply(`Tớ đã thêm **"${targetSong.fileName}"** vào danh sách chờ rồi đó! <:mahiru_coffee:1528589084921167902>`);

    if (!currentConnection || audioPlayer?.state.status === AudioPlayerStatus.Idle) {
      currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      playNextSong();
    }
  }

  // --- LỆNH PHÁT THEO PLAYLIST (/playlist) ---
  if (commandName === "playlist") {
    const playlistName = interaction.options.getString("name");
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return await interaction.reply({
        content: "Cậu chưa vào phòng thoại (Voice Channel) kìa! Mau vào trước rồi tớ mới mở nhạc cho nghe được nhé! <:MahiruBoyfriendSweaterStickerVer:1528588241844965457>",
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
    songs.forEach((song) => songQueue.push(song));

    await interaction.reply(`Tớ đã thêm **${songs.length} bài hát** từ Playlist **"${playlistName}"** vào danh sách chờ rồi nè! <:MahiruDoYourBest:1528588367548252323>`);

    if (!currentConnection || audioPlayer?.state.status === AudioPlayerStatus.Idle) {
      currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      playNextSong();
    }
  }

  // --- LỆNH PHÁT TẤT CẢ TỪ MỌI PLAYLIST (/playall) ---
  if (commandName === "playall") {
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return await interaction.reply({
        content: "Cậu chưa vào phòng thoại (Voice Channel) kìa! Mau vào trước rồi tớ mới mở nhạc cho nghe được nhé! <:MahiruBoyfriendSweaterStickerVer:1528588241844965457>",
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
    allSongs.forEach((song) => songQueue.push(song));

    await interaction.reply(`Tớ đã thêm toàn bộ **${allSongs.length} bài hát** (từ tất cả các Playlist) vào danh sách chờ rồi nè! <:MahiruDoYourBest:1528588367548252323>`);

    if (!currentConnection || audioPlayer?.state.status === AudioPlayerStatus.Idle) {
      currentConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      playNextSong();
    }
  }

  // --- LỆNH XÁO TRỘN DANH SÁCH HÀNG CHỜ (/shuffle) ---
  if (commandName === "shuffle") {
    if (songQueue.length < 2) {
      return await interaction.reply({
        content: "Cần ít nhất 2 bài hát trong danh sách chờ thì tớ mới tráo đổi thứ tự được chứ! <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }

    // Thuật toán tráo bài ngẫu nhiên (Fisher-Yates)
    for (let i = songQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [songQueue[i], songQueue[j]] = [songQueue[j], songQueue[i]];
    }

    await interaction.reply(`🎲 Tớ đã tráo đổi ngẫu nhiên vị trí của **${songQueue.length} bài hát** trong danh sách chờ rồi đó! <:mahiru_peace:1528589363628216370>`);
  }

  // --- LỆNH BỎ QUA BÀI (/skip) ---
  if (commandName === "skip") {
    if (audioPlayer && audioPlayer.state.status !== AudioPlayerStatus.Idle) {
      audioPlayer.stop();
      await interaction.reply("Tớ đã bỏ qua bài này giúp cậu rồi nè! <:mahiru_peace:1528589363628216370>");
    } else {
      await interaction.reply({
        content: "Hiện tại có bài nào đang phát đâu mà chuyển bài chứ... <:MahiruConfused:1528588311323480307>",
        ephemeral: true,
      });
    }
  }

  // --- LỆNH XEM DANH SÁCH CHỜ (/queue) ---
  if (commandName === "queue") {
    if (songQueue.length === 0) {
      return await interaction.reply("Danh sách chờ hiện tại đang trống nha! <:Mahiru_Okay:1528589309752377605>");
    }

    const queueList = songQueue
      .slice(0, 10)
      .map((song, index) => `${index + 1}. **${song.fileName}**`)
      .join("\n");

    const extraCount = songQueue.length > 10 ? `\n...và **${songQueue.length - 10}** bài khác.` : "";

    await interaction.reply(`Danh sách các bài đang chờ nè (Tổng: **${songQueue.length} bài**):\n${queueList}${extraCount}`);
  }

  // --- LỆNH TẮT NHẠC (/stop) ---
  if (commandName === "stop") {
    songQueue = [];

    if (currentConnection) {
      if (audioPlayer) audioPlayer.stop();
      currentConnection.destroy();
      currentConnection = null;

      await interaction.reply("Tớ đã xóa hàng chờ, tắt nhạc và rời phòng thoại rồi nhé! <:mahiru_wave_careful:1528615802545246258>");
    } else {
      await interaction.reply({
        content: "Tớ có đang ở trong phòng thoại phát nhạc đâu chứ... <:MahiruHmph:1528588485685149887>",
        ephemeral: true,
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);