# 🎧 Studio Listening Pro

> 一个把「看视频」变成「真正学进去」的英语听力学习器。
> 视频精听 + 点击查词 + SM-2 间隔重复记忆，全部在一个轻量的 React 应用里。

无需任何后端、无需注册，`clone` 下来就能跑。配置 Firebase 后可选开启多设备云同步。

---

## ✨ 核心功能

**沉浸式精听（学习舱）**
- 🎬 视频 + 双语字幕同步高亮，当前句自动滚动进视野
- 🔁 单句循环复读（精听训练的核心）
- 🐢 0.5× / 0.75× / 1× / 1.25× / 1.5× 变速播放
- 🎯 进度条拖动、上一句 / 下一句精准跳转、点击任意字幕跳播
- 🙈 盲听模式：隐藏英文或中文，逼自己用耳朵
- ⌨️ 全键盘操作（见下方快捷键表）

**点击即查词**
- 点字幕里任意单词 → 弹出音标、英文释义、真人发音
- 释义来自免费的 [dictionaryapi.dev](https://dictionaryapi.dev/)（无需 API Key）
- 浏览器内置 TTS 作为发音兜底
- 已收藏的生词在字幕里**金色高亮**，重复出现时一眼可见

**SM-2 间隔重复记忆（记忆复习）**
- 与 Anki 同款的科学复习算法，按遗忘曲线安排复习
- 「忘记 / 困难 / 良好 / 简单」四档评分，每档显示下次复习间隔
- 评「忘记」的词当天会再次出现，符合 Anki 行为

**数据中心**
- 总词汇量、今日待复习、已掌握数、平均熟练度，全部基于真实学习数据计算

**本地优先，云同步可选**
- 默认用浏览器 `localStorage`，开箱即用、零配置
- 配好 Firebase 后自动切换为云端实时同步，多设备共享单词本

---

## ⌨️ 键盘快捷键（学习舱）

| 按键 | 作用 |
|------|------|
| `空格` | 播放 / 暂停 |
| `←` / `→` | 上一句 / 下一句 |
| `R` | 切换当前句循环复读 |
| `↑` / `↓` | 加速 / 减速 |

---

## 🚀 快速开始

```bash
git clone https://github.com/<your-name>/studio-listening-pro.git
cd studio-listening-pro
npm install
npm run dev
```

打开终端提示的本地地址即可。**此时就是本地模式，所有数据存在浏览器里。**

---

## ☁️ 开启云同步（可选）

1. 在 [Firebase 控制台](https://console.firebase.google.com/) 新建项目
2. 开启 **Authentication → 匿名登录**，并创建 **Firestore 数据库**
3. 复制 Web 应用的 config，参照 `.env.example` 填到 `.env`：

```env
VITE_FIREBASE_CONFIG={"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}
```

重启 `npm run dev`，左下角会显示「云端」即表示生效。Firebase SDK 是按需动态加载的，不配置时完全不会引入。

---

## 🎥 替换为你自己的视频与字幕

所有内容集中在 `src/App.tsx` 的 `VIDEOS` 数组里。**示例视频是公开测试片，字幕是原创教学内容**，请替换成你自己的素材：

```ts
{
  id: "v1",
  title: "你的视频标题",
  episode: "EP.01",
  tags: ["日常"],
  accent: "US",                 // "US" | "UK" | "AU"
  difficulty: "intermediate",   // "beginner" | "intermediate" | "advanced" | "hard"
  durationStr: "12:30",
  durationMins: 12,
  uploadDate: "2025-01-01",
  coverUrl: "封面图 URL",
  videoUrl: "视频 mp4 / m3u8 URL",
  subtitles: [
    { id: 0, start: 0, end: 3.5, en: "English line.", zh: "中文翻译。" },
    // start / end 为秒，决定字幕同步与跳句时机
  ],
}
```

> 💡 **生成字幕的建议**：可用 [OpenAI Whisper](https://github.com/openai/whisper) 自动转写视频生成带时间轴的英文字幕，再机翻 / 人工校对中文，转成上面的 `subtitles` 格式。后续可以做一个把 `.srt` 转成本结构的小脚本。

---

## 🛠 技术栈

- **React 18 + TypeScript** — 全量类型，组件清晰
- **Vite** — 秒级启动的构建工具
- **Tailwind CSS** — 原子化样式
- **lucide-react** — 图标
- **Firebase**（可选）— Firestore 云同步
- **dictionaryapi.dev** — 免费词典 API
- **Web Speech API** — 浏览器原生发音

---

## 📁 项目结构

```
studio-listening-pro/
├─ index.html
├─ src/
│  ├─ App.tsx        # 全部应用逻辑（已按区块分层，便于拆分）
│  ├─ main.tsx
│  └─ index.css
├─ .env.example      # Firebase 配置模板
├─ tailwind.config.js
└─ vite.config.ts
```

`App.tsx` 内部已分层为：类型定义 → SM-2 算法 → 词典服务 → 存储层（本地/云自动切换）→ 数据 → 各功能组件。日后可以平滑拆成 `lib/`、`data/`、`components/` 等独立文件。

---

## 🗺 后续可做（欢迎 PR）

- [ ] `.srt` / `.vtt` 字幕一键导入
- [ ] 单词本导出为 Anki `.apkg` / CSV
- [ ] 影片管理后台（不必改代码就能加片）
- [ ] 中文释义自动补全（接入翻译 API）
- [ ] 学习连续打卡与每日时长的真实统计
- [ ] PWA 离线支持

---

## 🤝 贡献

欢迎提 Issue 和 PR。本项目以「让中文母语者更高效地用视频学英语」为目标，任何提升学习体验的想法都很受欢迎。

## 📄 协议

[MIT](./LICENSE)
