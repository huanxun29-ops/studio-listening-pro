import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  BookOpen,
  Clock,
  RefreshCw,
  CheckCircle,
  Film,
  Search,
  ArrowLeft,
  Volume2,
  Eye,
  EyeOff,
  Gauge,
  Loader2,
  Cloud,
  HardDrive,
} from "lucide-react";

/* ==========================================================================
 * Studio Listening Pro — 沉浸式英语听力学习器
 * --------------------------------------------------------------------------
 * 设计目标：clone 下来直接 `npm run dev` 就能跑（本地 localStorage 模式）。
 * 若在 .env 里配置了 Firebase，则自动切换为云端同步模式（多设备共享单词本）。
 * ========================================================================== */

// ==========================================================================
// 类型定义
// ==========================================================================
interface Subtitle {
  id: number;
  start: number; // 秒
  end: number; // 秒
  en: string;
  zh: string;
}

type Difficulty = "beginner" | "intermediate" | "advanced" | "hard";
type Accent = "US" | "UK" | "AU";

interface Video {
  id: string;
  title: string;
  episode: string;
  tags: string[];
  accent: Accent;
  difficulty: Difficulty;
  durationStr: string;
  durationMins: number;
  uploadDate: string;
  coverUrl: string;
  videoUrl: string;
  subtitles: Subtitle[];
}

interface VocabWord {
  id: string;
  word: string;
  zh: string; // 中文/自定义释义
  phonetic?: string; // 音标，如 /ˈwɛlkəm/
  definition?: string; // 英文释义（来自词典 API）
  context?: string; // 收藏时所在的例句
  // SM-2 间隔重复字段
  interval: number;
  repetitions: number;
  easeFactor: number;
  nextReviewDate: string; // ISO
  createdAt: string; // ISO
}

// SM-2 评分：0~5，本应用使用 1(忘记) / 3(困难) / 4(良好) / 5(简单)
type Quality = 1 | 3 | 4 | 5;

type Tab = "library" | "player" | "anki" | "profile";

// ==========================================================================
// 文案：把中文标签集中管理，逻辑判断只用英文枚举（避免魔法字符串散落）
// ==========================================================================
const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  beginner: "入门",
  intermediate: "中阶",
  advanced: "进阶",
  hard: "困难",
};

const ACCENT_LABEL: Record<Accent, string> = {
  US: "美式",
  UK: "英式",
  AU: "澳式",
};

const DIFFICULTY_STYLE: Record<Difficulty, string> = {
  beginner: "bg-green-500/85",
  intermediate: "bg-sky-500/85",
  advanced: "bg-orange-500/85",
  hard: "bg-red-500/85",
};

// ==========================================================================
// 核心逻辑：SM-2 间隔重复算法（Anki 同款）
//   quality < 3 视为答错，repetitions 归零；>=3 视为答对，间隔指数增长。
// ==========================================================================
function calculateSM2(
  quality: Quality,
  word: Pick<VocabWord, "interval" | "repetitions" | "easeFactor">
) {
  let { interval, repetitions, easeFactor } = word;

  if (quality >= 3) {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);
    repetitions += 1;
  } else {
    repetitions = 0;
    interval = 1;
  }

  easeFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  easeFactor = Math.max(1.3, easeFactor);

  const nextReviewDate = new Date();
  nextReviewDate.setDate(nextReviewDate.getDate() + interval);

  return {
    interval,
    repetitions,
    easeFactor,
    nextReviewDate: nextReviewDate.toISOString(),
  };
}

// ==========================================================================
// 词典服务：免费的 dictionaryapi.dev（英英释义 + 音标 + 发音），无需 API Key。
//   学英语用英英释义比生硬的机翻更扎实；中文释义留作可选/可编辑字段。
// ==========================================================================
interface LookupResult {
  phonetic?: string;
  definition?: string;
  audioUrl?: string;
}

async function lookupWord(raw: string): Promise<LookupResult> {
  const word = raw.toLowerCase().trim();
  if (!word) return {};
  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
    );
    if (!res.ok) return {};
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry) return {};

    const phonetic: string | undefined =
      entry.phonetic ||
      entry.phonetics?.find((p: any) => p.text)?.text;
    const audioUrl: string | undefined = entry.phonetics?.find(
      (p: any) => p.audio
    )?.audio;
    const definition: string | undefined =
      entry.meanings?.[0]?.definitions?.[0]?.definition;

    return { phonetic, definition, audioUrl };
  } catch {
    return {};
  }
}

// 浏览器内置语音合成，作为发音兜底（无需联网音频文件）
function speak(text: string) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  utter.rate = 0.9;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

// ==========================================================================
// 存储层：本地优先，云同步可选
//   - 未配置 Firebase → 使用 localStorage（任何人 clone 即用）
//   - 配置了 Firebase → 动态加载 SDK，云端实时同步
// 通过统一的 VocabStore 接口对上层透明。
// ==========================================================================
interface VocabStore {
  mode: "cloud" | "local";
  userLabel: string;
  subscribe(cb: (words: VocabWord[]) => void): () => void;
  upsert(word: VocabWord): Promise<void>;
  remove(id: string): Promise<void>;
}

function readFirebaseConfig(): Record<string, unknown> | null {
  try {
    const raw = import.meta.env.VITE_FIREBASE_CONFIG;
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    return cfg && cfg.apiKey ? cfg : null;
  } catch {
    return null;
  }
}

// ---- 本地存储实现 -------------------------------------------------------
const LOCAL_KEY = "studio-pro:vocab";

function createLocalStore(): VocabStore {
  const listeners = new Set<(w: VocabWord[]) => void>();

  const read = (): VocabWord[] => {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]");
    } catch {
      return [];
    }
  };
  const write = (words: VocabWord[]) => {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(words));
    listeners.forEach((cb) => cb(words));
  };

  return {
    mode: "local",
    userLabel: "本地存档",
    subscribe(cb) {
      cb(read());
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async upsert(word) {
      const words = read();
      const idx = words.findIndex((w) => w.id === word.id);
      if (idx >= 0) words[idx] = word;
      else words.push(word);
      write(words);
    },
    async remove(id) {
      write(read().filter((w) => w.id !== id));
    },
  };
}

// ---- 云端（Firebase）实现 ----------------------------------------------
async function createCloudStore(
  config: Record<string, unknown>
): Promise<VocabStore> {
  const { initializeApp } = await import("firebase/app");
  const { getAuth, signInAnonymously, onAuthStateChanged } = await import(
    "firebase/auth"
  );
  const { getFirestore, collection, doc, setDoc, onSnapshot, deleteDoc } =
    await import("firebase/firestore");

  const app = initializeApp(config as any);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const appId = import.meta.env.VITE_APP_ID || "studio-pro";

  const uid: string = await new Promise((resolve) => {
    onAuthStateChanged(auth, (u) => {
      if (u) resolve(u.uid);
    });
    signInAnonymously(auth).catch((e) => console.error("匿名登录失败:", e));
  });

  const colRef = collection(db, "studio-pro", appId, "users", uid, "vocabulary");

  return {
    mode: "cloud",
    userLabel: `云端 · ${uid.slice(0, 6)}`,
    subscribe(cb) {
      return onSnapshot(
        colRef,
        (snap) => {
          const list: VocabWord[] = [];
          snap.forEach((d) => list.push({ id: d.id, ...d.data() } as VocabWord));
          cb(list);
        },
        (err) => console.error("云同步错误:", err)
      );
    },
    async upsert(word) {
      await setDoc(doc(colRef, word.id), word);
    },
    async remove(id) {
      await deleteDoc(doc(colRef, id));
    },
  };
}

async function createStore(): Promise<VocabStore> {
  const config = readFirebaseConfig();
  if (config) {
    try {
      return await createCloudStore(config);
    } catch (e) {
      console.warn("云端初始化失败，已回退到本地模式:", e);
    }
  }
  return createLocalStore();
}

// ==========================================================================
// 示例数据
//   注意：videoUrl 为公开测试视频；字幕为原创教学示例（避免版权问题）。
//   接入真实内容请参见 README「替换为你自己的视频与字幕」。
// ==========================================================================
const DEMO_SUBTITLES_A: Subtitle[] = [
  { id: 0, start: 0, end: 4, en: "Stay hungry. Stay foolish.", zh: "求知若饥，虚心若愚。" },
  { id: 1, start: 4, end: 9, en: "Your time is limited, so don't waste it living someone else's life.", zh: "你的时间有限，不要浪费时间活在别人的生活里。" },
  { id: 2, start: 9, end: 14, en: "Don't be trapped by dogma, which is living with the results of other people's thinking.", zh: "不要被教条所困，那等于活在别人思考的结果里。" },
  { id: 3, start: 14, end: 19, en: "Have the courage to follow your heart and intuition.", zh: "要有勇气追随自己的内心与直觉。" },
  { id: 4, start: 19, end: 24, en: "Everything else is secondary.", zh: "其余的一切都是次要的。" },
];

const DEMO_SUBTITLES_B: Subtitle[] = [
  { id: 0, start: 0, end: 4, en: "Creativity is as important as literacy.", zh: "创造力和读写能力一样重要。" },
  { id: 1, start: 4, end: 9, en: "If you're not prepared to be wrong, you'll never come up with anything original.", zh: "如果你不准备犯错，就永远想不出任何原创的东西。" },
  { id: 2, start: 9, end: 14, en: "We don't grow into creativity, we grow out of it.", zh: "我们不是逐渐获得创造力，而是逐渐失去它。" },
  { id: 3, start: 14, end: 19, en: "Children will take a chance.", zh: "孩子愿意去冒险尝试。" },
  { id: 4, start: 19, end: 24, en: "They are not frightened of being wrong.", zh: "他们不害怕犯错。" },
];

const DEMO_SUBTITLES_C: Subtitle[] = [
  { id: 0, start: 0, end: 4, en: "Hey, how's it going? Long time no see.", zh: "嘿，最近怎么样？好久不见。" },
  { id: 1, start: 4, end: 8, en: "I've been swamped at work lately.", zh: "我最近工作忙得不可开交。" },
  { id: 2, start: 8, end: 12, en: "Do you want to grab a coffee sometime this week?", zh: "这周找个时间一起喝杯咖啡怎么样？" },
  { id: 3, start: 12, end: 16, en: "Sure, that sounds great. How about Friday?", zh: "好啊，听起来不错。周五怎么样？" },
  { id: 4, start: 16, end: 20, en: "Friday works for me. Let's catch up then.", zh: "周五可以。到时候好好聊聊。" },
];

const DEMO_VIDEO_URL = "https://www.w3schools.com/html/mov_bbb.mp4";

const VIDEOS: Video[] = [
  {
    id: "v1",
    title: "毕业典礼演讲：求知若饥（示例字幕）",
    episode: "EP.01",
    tags: ["励志", "演讲"],
    accent: "US",
    difficulty: "advanced",
    durationStr: "00:24",
    durationMins: 1,
    uploadDate: "2024-11-05",
    coverUrl:
      "https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=600&q=80",
    videoUrl: DEMO_VIDEO_URL,
    subtitles: DEMO_SUBTITLES_A,
  },
  {
    id: "v2",
    title: "TED 主题：创造力的重要性（示例字幕）",
    episode: "TED",
    tags: ["学术", "教育"],
    accent: "UK",
    difficulty: "advanced",
    durationStr: "00:24",
    durationMins: 1,
    uploadDate: "2024-11-10",
    coverUrl:
      "https://images.unsplash.com/photo-1475669698648-2f144fcaaeb1?auto=format&fit=crop&w=600&q=80",
    videoUrl: DEMO_VIDEO_URL,
    subtitles: DEMO_SUBTITLES_B,
  },
  {
    id: "v3",
    title: "日常英语对话：约朋友喝咖啡（示例字幕）",
    episode: "Daily.05",
    tags: ["日常", "口语"],
    accent: "US",
    difficulty: "beginner",
    durationStr: "00:20",
    durationMins: 1,
    uploadDate: "2024-11-15",
    coverUrl:
      "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=600&q=80",
    videoUrl: DEMO_VIDEO_URL,
    subtitles: DEMO_SUBTITLES_C,
  },
  {
    id: "v4",
    title: "新闻播报：全球科技趋势（示例字幕）",
    episode: "BBC.01",
    tags: ["新闻"],
    accent: "UK",
    difficulty: "hard",
    durationStr: "00:24",
    durationMins: 1,
    uploadDate: "2024-11-18",
    coverUrl:
      "https://images.unsplash.com/photo-1495020689067-958852a7765e?auto=format&fit=crop&w=600&q=80",
    videoUrl: DEMO_VIDEO_URL,
    subtitles: DEMO_SUBTITLES_B,
  },
  {
    id: "v5",
    title: "文化漫谈：俚语解析（示例字幕）",
    episode: "AU.02",
    tags: ["文化", "口语"],
    accent: "AU",
    difficulty: "intermediate",
    durationStr: "00:20",
    durationMins: 1,
    uploadDate: "2024-11-01",
    coverUrl:
      "https://images.unsplash.com/photo-1523482580672-f109ba8cb9be?auto=format&fit=crop&w=600&q=80",
    videoUrl: DEMO_VIDEO_URL,
    subtitles: DEMO_SUBTITLES_C,
  },
];

// ==========================================================================
// 工具函数
// ==========================================================================
const normalizeWord = (raw: string) => raw.toLowerCase().replace(/[^a-z']/g, "");

const formatTime = (sec: number) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const isDue = (w: VocabWord) => new Date(w.nextReviewDate) <= new Date();

// ==========================================================================
// 主应用
// ==========================================================================
export default function App() {
  const [store, setStore] = useState<VocabStore | null>(null);
  const [vocab, setVocab] = useState<VocabWord[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("library");
  const [currentVideo, setCurrentVideo] = useState<Video | null>(null);

  // 初始化存储（自动选择本地 / 云端）
  useEffect(() => {
    let unsub = () => {};
    let alive = true;
    createStore().then((s) => {
      if (!alive) return;
      setStore(s);
      unsub = s.subscribe(setVocab);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const vocabMap = useMemo(() => {
    const m = new Map<string, VocabWord>();
    vocab.forEach((w) => m.set(w.id, w));
    return m;
  }, [vocab]);

  // 收藏 / 更新单词（先本地乐观写入词典信息，再持久化）
  const addWord = useCallback(
    async (rawWord: string, context = "") => {
      if (!store) return;
      const id = normalizeWord(rawWord);
      if (!id) return;

      const existing = vocabMap.get(id);
      const base: VocabWord =
        existing || {
          id,
          word: rawWord.replace(/[^a-zA-Z']/g, ""),
          zh: "",
          context,
          interval: 0,
          repetitions: 0,
          easeFactor: 2.5,
          nextReviewDate: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };

      await store.upsert(base);

      // 异步补全词典信息（不阻塞收藏动作）
      if (!base.definition) {
        const info = await lookupWord(id);
        if (info.phonetic || info.definition) {
          await store.upsert({
            ...base,
            phonetic: info.phonetic || base.phonetic,
            definition: info.definition || base.definition,
          });
        }
      }
    },
    [store, vocabMap]
  );

  const updateWord = useCallback(
    async (word: VocabWord) => {
      if (store) await store.upsert(word);
    },
    [store]
  );

  const removeWord = useCallback(
    async (id: string) => {
      if (store) await store.remove(id);
    },
    [store]
  );

  const handleSelectVideo = (video: Video) => {
    setCurrentVideo(video);
    setActiveTab("player");
  };

  const dueCount = vocab.filter(isDue).length;

  if (!store) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50 text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin mr-3" />
        正在准备你的学习空间…
      </div>
    );
  }

  const nav: { tab: Tab; icon: React.ReactNode; label: string; badge?: number }[] = [
    { tab: "library", icon: <Film size={20} />, label: "影音库" },
    { tab: "player", icon: <Play size={20} />, label: "学习舱" },
    { tab: "anki", icon: <RefreshCw size={20} />, label: "记忆复习", badge: dueCount },
    { tab: "profile", icon: <Clock size={20} />, label: "数据中心" },
  ];

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-900 font-sans overflow-hidden">
      {/* 侧边导航（桌面） */}
      <aside className="w-64 bg-white border-r border-slate-200 flex-col hidden md:flex shrink-0">
        <div className="p-6 font-bold text-xl text-blue-600 flex items-center gap-2">
          <BookOpen className="w-6 h-6" /> Studio Pro
        </div>
        <nav className="flex-1 px-4 space-y-2">
          {nav.map((n) => (
            <NavItem
              key={n.tab}
              icon={n.icon}
              label={n.label}
              active={activeTab === n.tab}
              badge={n.badge}
              onClick={() => setActiveTab(n.tab)}
            />
          ))}
        </nav>
        <div className="p-4 border-t border-slate-100 text-xs text-slate-500 flex items-center gap-2">
          {store.mode === "cloud" ? <Cloud size={14} /> : <HardDrive size={14} />}
          {store.userLabel}
        </div>
      </aside>

      {/* 主内容区 */}
      <main className="flex-1 relative flex flex-col h-full overflow-hidden pb-16 md:pb-0">
        {activeTab === "library" && <LibraryWorkspace onSelectVideo={handleSelectVideo} />}
        {activeTab === "player" && (
          <PlayerWorkspace
            video={currentVideo}
            vocabMap={vocabMap}
            addWord={addWord}
            onBack={() => setActiveTab("library")}
          />
        )}
        {activeTab === "anki" && (
          <AnkiReviewWorkspace vocab={vocab} updateWord={updateWord} />
        )}
        {activeTab === "profile" && <DashboardWorkspace vocab={vocab} />}
      </main>

      {/* 底部导航（移动端） */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 flex justify-around z-20">
        {nav.map((n) => (
          <button
            key={n.tab}
            onClick={() => setActiveTab(n.tab)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium relative ${
              activeTab === n.tab ? "text-blue-600" : "text-slate-500"
            }`}
          >
            {n.icon}
            {n.label}
            {!!n.badge && n.badge > 0 && (
              <span className="absolute top-1 right-1/4 bg-red-500 text-white text-[9px] rounded-full px-1.5 py-0.5 font-bold">
                {n.badge}
              </span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ==========================================================================
// 影音库
// ==========================================================================
function LibraryWorkspace({
  onSelectVideo,
}: {
  onSelectVideo: (v: Video) => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return VIDEOS.filter(
      (v) =>
        v.title.toLowerCase().includes(q) ||
        v.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [query]);

  const latest = [...VIDEOS].sort(
    (a, b) => +new Date(b.uploadDate) - +new Date(a.uploadDate)
  );
  const shortVideos = VIDEOS.filter((v) => v.durationMins < 10);
  const ukVideos = VIDEOS.filter((v) => v.accent === "UK");
  const advanced = VIDEOS.filter(
    (v) => v.difficulty === "advanced" || v.difficulty === "hard"
  );

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-8 max-w-[1600px] mx-auto w-full no-scrollbar">
      <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-4 mb-8 md:mb-10 px-2">
        <div>
          <h1 className="text-3xl md:text-4xl font-extrabold text-slate-900 tracking-tight mb-2">
            影音库
          </h1>
          <p className="text-slate-500 font-medium">
            精选不同难度与口音的沉浸式听力素材。
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题或标签…"
            aria-label="搜索影片"
            className="pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm w-full md:w-64 transition-all"
          />
        </div>
      </div>

      {filtered ? (
        filtered.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 px-2">
            {filtered.map((v) => (
              <VideoCard key={v.id} video={v} onSelect={onSelectVideo} />
            ))}
          </div>
        ) : (
          <div className="text-center text-slate-400 py-20">
            没有找到「{query}」相关的影片，换个关键词试试。
          </div>
        )
      ) : (
        <div className="space-y-8">
          <VideoRow title="🆕 最新上传" subtitle="第一时间掌握最新学习资源" videos={latest} onSelect={onSelectVideo} />
          <VideoRow title="⚡ 碎片时间 (10 分钟内)" subtitle="通勤、等车也能磨练听感" videos={shortVideos} onSelect={onSelectVideo} />
          <VideoRow title="☕ 经典英式发音" subtitle="纯正英音素材" videos={ukVideos} onSelect={onSelectVideo} />
          <VideoRow title="🔥 进阶与困难挑战" subtitle="突破舒适圈，挑战原速听力" videos={advanced} onSelect={onSelectVideo} />
        </div>
      )}
    </div>
  );
}

function VideoRow({
  title,
  subtitle,
  videos,
  onSelect,
}: {
  title: string;
  subtitle?: string;
  videos: Video[];
  onSelect: (v: Video) => void;
}) {
  if (!videos.length) return null;
  return (
    <div className="flex flex-col">
      <div className="mb-4 px-2">
        <h2 className="text-xl md:text-2xl font-bold text-slate-800 tracking-tight">{title}</h2>
        {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
      </div>
      <div className="flex gap-5 overflow-x-auto pb-6 pt-2 px-2 snap-x snap-mandatory no-scrollbar">
        {videos.map((v) => (
          <div key={v.id} className="snap-start shrink-0 w-64 md:w-72">
            <VideoCard video={v} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </div>
  );
}

function VideoCard({
  video,
  onSelect,
}: {
  video: Video;
  onSelect: (v: Video) => void;
}) {
  return (
    <button
      onClick={() => onSelect(video)}
      className="text-left w-full bg-white rounded-2xl overflow-hidden border border-slate-200 shadow-sm hover:shadow-xl hover:-translate-y-1.5 transition-all duration-300 cursor-pointer group flex flex-col focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      <div className="relative aspect-video bg-slate-200 overflow-hidden">
        <img
          src={video.coverUrl}
          alt={video.title}
          loading="lazy"
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ease-out"
        />
        <span className="absolute bottom-2 right-2 bg-black/80 text-white text-xs font-bold px-2 py-1 rounded-md backdrop-blur-sm">
          {video.durationStr}
        </span>
        <span
          className={`absolute top-2 left-2 text-[10px] font-bold px-2 py-1 rounded-md backdrop-blur-md text-white ${DIFFICULTY_STYLE[video.difficulty]}`}
        >
          {DIFFICULTY_LABEL[video.difficulty]}
        </span>
      </div>
      <div className="p-4 flex flex-col flex-1">
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] font-bold text-blue-600 tracking-wider uppercase bg-blue-50 px-2 py-0.5 rounded-full">
            {video.episode}
          </span>
          <span className="text-[10px] font-bold text-slate-500 border border-slate-200 px-2 py-0.5 rounded-full">
            {ACCENT_LABEL[video.accent]}
          </span>
        </div>
        <h3 className="font-bold text-slate-800 line-clamp-2 leading-snug mb-3 flex-1 mt-1">
          {video.title}
        </h3>
        <div className="flex flex-wrap gap-1.5 mt-auto">
          {video.tags.map((t) => (
            <span
              key={t}
              className="text-[10px] font-semibold bg-slate-100 text-slate-600 px-2 py-1 rounded-md"
            >
              #{t}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

// ==========================================================================
// 学习舱（核心听力学习区）
// ==========================================================================
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

function PlayerWorkspace({
  video,
  vocabMap,
  addWord,
  onBack,
}: {
  video: Video | null;
  vocabMap: Map<string, VocabWord>;
  addWord: (w: string, ctx?: string) => void;
  onBack: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const subListRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loopIndex, setLoopIndex] = useState<number | null>(null); // 单句循环
  const [showEn, setShowEn] = useState(true);
  const [showZh, setShowZh] = useState(true);
  const [popup, setPopup] = useState<{
    word: string;
    info: LookupResult | null;
    loading: boolean;
  } | null>(null);

  const subtitles = video?.subtitles ?? [];

  const activeIndex = useMemo(
    () =>
      subtitles.findIndex((s) => currentTime >= s.start && currentTime < s.end),
    [currentTime, subtitles]
  );

  // 播放进度（用 timeupdate 事件，避免每帧 setState）
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onTime = () => {
      setCurrentTime(el.currentTime);
      // 单句循环：超过该句结尾就跳回句首
      if (loopIndex !== null && subtitles[loopIndex]) {
        const s = subtitles[loopIndex];
        if (el.currentTime >= s.end) el.currentTime = s.start;
      }
    };
    const onMeta = () => setDuration(el.duration || 0);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
    };
  }, [loopIndex, subtitles]);

  // 同步播放速度
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, video]);

  // 切换影片时重置播放器状态
  useEffect(() => {
    setLoopIndex(null);
    setCurrentTime(0);
    setIsPlaying(false);
    setPopup(null);
  }, [video?.id]);

  // 当前字幕自动滚动进视野
  useEffect(() => {
    if (activeIndex < 0 || !subListRef.current) return;
    const node = subListRef.current.querySelector<HTMLElement>(
      `[data-sub-index="${activeIndex}"]`
    );
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex]);

  const playPause = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.paused ? el.play() : el.pause();
  }, []);

  const seekTo = (t: number) => {
    if (videoRef.current) videoRef.current.currentTime = Math.max(0, t);
  };

  const jumpToSub = useCallback(
    (index: number) => {
      const s = subtitles[index];
      if (!s) return;
      seekTo(s.start + 0.01);
      videoRef.current?.play();
    },
    [subtitles]
  );

  const jump = useCallback(
    (dir: "prev" | "next") => {
      const base = activeIndex >= 0 ? activeIndex : 0;
      const target =
        dir === "prev" ? Math.max(0, base - 1) : Math.min(subtitles.length - 1, base + 1);
      jumpToSub(target);
    },
    [activeIndex, subtitles.length, jumpToSub]
  );

  // 键盘快捷键（输入框聚焦时不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      switch (e.code) {
        case "Space":
          e.preventDefault();
          playPause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          jump("prev");
          break;
        case "ArrowRight":
          e.preventDefault();
          jump("next");
          break;
        case "KeyR":
          if (activeIndex >= 0) setLoopIndex((p) => (p === activeIndex ? null : activeIndex));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)] ?? s);
          break;
        case "ArrowDown":
          e.preventDefault();
          setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)] ?? s);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playPause, jump, activeIndex]);

  const handleWordClick = async (raw: string, context: string) => {
    const word = raw.replace(/[^a-zA-Z']/g, "");
    if (!word) return;
    speak(word);
    addWord(word, context);
    setPopup({ word, info: null, loading: true });
    const info = await lookupWord(word);
    setPopup({ word, info, loading: false });
  };

  if (!video) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-500 px-6 text-center">
        <Film size={64} className="text-slate-300 mb-4" />
        <h2 className="text-2xl font-bold text-slate-800 mb-4">还没有选择影片</h2>
        <p className="mb-4 text-slate-400">去影音库挑一支开始精听吧。</p>
        <button
          onClick={onBack}
          className="bg-blue-600 text-white px-6 py-2 rounded-full font-bold hover:bg-blue-700 transition focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          去影音库选择
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-50 p-4 gap-4 max-w-5xl mx-auto w-full relative">
      {/* 顶部 */}
      <div className="flex items-center gap-3 py-1 shrink-0">
        <button
          onClick={onBack}
          aria-label="返回影音库"
          className="p-2 bg-white rounded-full border border-slate-200 shadow-sm hover:bg-slate-50 transition focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          <ArrowLeft size={20} className="text-slate-600" />
        </button>
        <h2 className="font-bold text-base md:text-lg text-slate-800 truncate">{video.title}</h2>
      </div>

      {/* 视频 + 控制条 */}
      <div className="w-full bg-black rounded-2xl overflow-hidden relative shadow-xl shrink-0">
        <video
          ref={videoRef}
          className="w-full aspect-video object-contain bg-black"
          src={video.videoUrl}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onClick={playPause}
          playsInline
        />
      </div>

      {/* 进度条 */}
      <div className="flex items-center gap-3 px-1 shrink-0 text-xs text-slate-500 font-medium tabular-nums">
        <span>{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={(e) => seekTo(parseFloat(e.target.value))}
          aria-label="播放进度"
          className="flex-1 accent-blue-600 cursor-pointer"
        />
        <span>{formatTime(duration)}</span>
      </div>

      {/* 控制工具栏 */}
      <div className="flex flex-wrap items-center justify-center gap-2 md:gap-3 shrink-0">
        <ControlBtn onClick={() => jump("prev")} title="上一句 (←)">
          <SkipBack size={18} />
        </ControlBtn>
        <button
          onClick={playPause}
          aria-label={isPlaying ? "暂停" : "播放"}
          title="播放 / 暂停 (空格)"
          className="bg-blue-600 text-white p-3 rounded-full hover:bg-blue-700 transition focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" className="ml-0.5" />}
        </button>
        <ControlBtn onClick={() => jump("next")} title="下一句 (→)">
          <SkipForward size={18} />
        </ControlBtn>

        <ControlBtn
          active={loopIndex !== null}
          onClick={() => setLoopIndex((p) => (p === null ? (activeIndex >= 0 ? activeIndex : 0) : null))}
          title="单句循环 (R)"
        >
          <Repeat size={18} />
        </ControlBtn>

        {/* 变速 */}
        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-full px-2 py-1 shadow-sm">
          <Gauge size={16} className="text-slate-400" />
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`text-xs font-bold px-1.5 py-0.5 rounded-full transition ${
                speed === s ? "bg-blue-600 text-white" : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>

        {/* 字幕显隐（盲听模式） */}
        <ControlBtn active={!showEn} onClick={() => setShowEn((v) => !v)} title="隐藏英文（盲听）">
          {showEn ? <Eye size={18} /> : <EyeOff size={18} />}
        </ControlBtn>
        <button
          onClick={() => setShowZh((v) => !v)}
          className={`text-xs font-bold px-3 py-2 rounded-full border shadow-sm transition ${
            showZh ? "bg-white text-slate-600 border-slate-200" : "bg-slate-200 text-slate-400 border-transparent"
          }`}
          title="显示 / 隐藏中文"
        >
          中
        </button>
      </div>

      {/* 字幕滚动区 */}
      <div
        ref={subListRef}
        className="flex-1 overflow-y-auto bg-white rounded-2xl shadow-sm border border-slate-200 p-4 md:p-6 space-y-3 no-scrollbar"
      >
        {subtitles.map((sub, index) => (
          <div
            key={sub.id}
            data-sub-index={index}
            className={`p-4 rounded-xl transition-all duration-300 border ${
              activeIndex === index
                ? "bg-blue-50 border-blue-200 shadow-md"
                : "border-transparent hover:bg-slate-50"
            }`}
          >
            <div className="flex items-start gap-2">
              <button
                onClick={() => jumpToSub(index)}
                aria-label="跳到这一句"
                className="mt-1.5 text-slate-300 hover:text-blue-600 transition shrink-0"
                title="跳到这一句播放"
              >
                <Play size={14} fill="currentColor" />
              </button>
              {showEn ? (
                <p className="text-xl md:text-2xl font-bold text-slate-800 tracking-tight leading-relaxed">
                  {sub.en.split(/(\s+)/).map((token, i) => {
                    if (/^\s+$/.test(token)) return token;
                    const norm = normalizeWord(token);
                    const known = norm && vocabMap.has(norm);
                    return (
                      <span
                        key={i}
                        onClick={() => handleWordClick(token, sub.en)}
                        className={`cursor-pointer px-0.5 rounded transition-colors ${
                          known
                            ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                            : "hover:bg-blue-100 hover:text-blue-600"
                        }`}
                      >
                        {token}
                      </span>
                    );
                  })}
                </p>
              ) : (
                <p className="text-xl md:text-2xl font-bold text-slate-300 italic leading-relaxed">
                  （盲听中 · 点击眼睛图标显示）
                </p>
              )}
            </div>
            {showZh && (
              <p
                className={`text-slate-500 font-medium mt-2 ml-6 transition-opacity ${
                  activeIndex === index ? "opacity-100" : "opacity-60"
                }`}
              >
                {sub.zh}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* 查词弹窗 */}
      {popup && (
        <WordPopup
          word={popup.word}
          info={popup.info}
          loading={popup.loading}
          onClose={() => setPopup(null)}
        />
      )}
    </div>
  );
}

function ControlBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`p-2.5 rounded-full border shadow-sm transition focus:outline-none focus:ring-2 focus:ring-blue-400 ${
        active
          ? "bg-blue-600 text-white border-blue-600"
          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function WordPopup({
  word,
  info,
  loading,
  onClose,
}: {
  word: string;
  info: LookupResult | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[92%] max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 p-5 z-30 animate-in fade-in slide-in-from-bottom-2 duration-200"
      role="dialog"
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <h3 className="text-2xl font-extrabold text-slate-900">{word}</h3>
          <button
            onClick={() => {
              if (info?.audioUrl) new Audio(info.audioUrl).play().catch(() => speak(word));
              else speak(word);
            }}
            aria-label="朗读"
            className="text-blue-600 hover:text-blue-700"
          >
            <Volume2 size={20} />
          </button>
        </div>
        <button onClick={onClose} aria-label="关闭" className="text-slate-400 hover:text-slate-600 text-xl leading-none">
          ×
        </button>
      </div>
      {info?.phonetic && <p className="text-slate-400 font-mono text-sm mb-2">{info.phonetic}</p>}
      {loading ? (
        <p className="text-slate-400 text-sm flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> 正在查询释义…
        </p>
      ) : info?.definition ? (
        <p className="text-slate-600 leading-relaxed">{info.definition}</p>
      ) : (
        <p className="text-slate-400 text-sm">未找到释义，已加入单词本，可稍后自行补充。</p>
      )}
      <p className="text-xs text-emerald-600 mt-3 font-medium flex items-center gap-1">
        <CheckCircle size={12} /> 已加入单词本，将进入记忆复习计划
      </p>
    </div>
  );
}

// ==========================================================================
// Anki 记忆复习
//   进入时把"到期词"快照成一个会话队列，按 index 推进，不依赖云端回写延迟。
//   评"忘记(Again)"的词会被放回队列末尾，当天再练一次（符合 Anki 行为）。
// ==========================================================================
function AnkiReviewWorkspace({
  vocab,
  updateWord,
}: {
  vocab: VocabWord[];
  updateWord: (w: VocabWord) => void;
}) {
  const [queue, setQueue] = useState<VocabWord[]>([]);
  const [index, setIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [sessionDone, setSessionDone] = useState(0);
  const initialDue = useRef(0);

  // 仅在进入时根据当前到期词构建一次队列
  useEffect(() => {
    const due = vocab.filter(isDue);
    setQueue(due);
    initialDue.current = due.length;
    setIndex(0);
    setShowAnswer(false);
    setSessionDone(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = queue[index];

  const handleRate = (quality: Quality) => {
    if (!current) return;
    const sm2 = calculateSM2(quality, current);
    const updated: VocabWord = { ...current, ...sm2 };
    updateWord(updated); // 持久化

    setQueue((q) => {
      const next = [...q];
      if (quality < 3) {
        // 忘记：当天再练，挪到队尾
        next.push(updated);
      } else {
        setSessionDone((n) => n + 1);
      }
      return next;
    });
    setShowAnswer(false);
    setIndex((i) => i + 1);
  };

  if (initialDue.current === 0) {
    return (
      <EmptyState
        icon={<CheckCircle size={64} className="text-green-400 mb-4" />}
        title="今天清空啦 🎉"
        desc="没有到期需要复习的单词。去学习舱里收集一些新词吧。"
      />
    );
  }

  if (!current) {
    return (
      <EmptyState
        icon={<CheckCircle size={64} className="text-green-400 mb-4" />}
        title="本轮复习完成！"
        desc={`本次共巩固 ${sessionDone} 个单词，做得很好。`}
      />
    );
  }

  const progress = Math.round((sessionDone / Math.max(1, initialDue.current)) * 100);

  return (
    <div className="flex flex-col items-center justify-center h-full max-w-2xl mx-auto w-full p-4">
      {/* 进度条 */}
      <div className="w-full h-1.5 bg-slate-200 rounded-full mb-6 overflow-hidden">
        <div
          className="h-full bg-blue-600 rounded-full transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="w-full bg-white rounded-3xl shadow-xl border border-slate-100 p-8 md:p-10 flex flex-col items-center min-h-[420px]">
        <span className="bg-blue-100 text-blue-700 text-xs font-bold px-3 py-1 rounded-full mb-8">
          剩余 {queue.length - index} 词 · 已完成 {sessionDone}/{initialDue.current}
        </span>

        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-4xl md:text-5xl font-extrabold text-slate-900">{current.word}</h1>
          <button onClick={() => speak(current.word)} aria-label="朗读" className="text-blue-600">
            <Volume2 size={26} />
          </button>
        </div>
        {current.phonetic && <p className="text-slate-400 font-mono mb-6">{current.phonetic}</p>}

        {showAnswer ? (
          <div className="flex flex-col items-center w-full animate-in fade-in slide-in-from-bottom-4 duration-300">
            {current.definition && (
              <p className="text-base text-slate-600 text-center mb-2 px-4">{current.definition}</p>
            )}
            {current.zh && <p className="text-xl text-slate-700 font-medium mb-3">{current.zh}</p>}
            {current.context && (
              <p className="text-sm text-slate-400 italic text-center mb-8 px-4">“{current.context}”</p>
            )}

            <div className="w-full grid grid-cols-2 md:grid-cols-4 gap-3 mt-auto">
              <RateButton label="忘记" hint="<1分钟" color="bg-red-100 text-red-700 hover:bg-red-200" onClick={() => handleRate(1)} />
              <RateButton label="困难" hint="1天" color="bg-orange-100 text-orange-700 hover:bg-orange-200" onClick={() => handleRate(3)} />
              <RateButton label="良好" hint={`${current.repetitions === 0 ? 1 : current.repetitions === 1 ? 6 : Math.round(current.interval * current.easeFactor)}天`} color="bg-green-100 text-green-700 hover:bg-green-200" onClick={() => handleRate(4)} />
              <RateButton label="简单" hint="更久" color="bg-blue-100 text-blue-700 hover:bg-blue-200" onClick={() => handleRate(5)} />
            </div>
          </div>
        ) : (
          <button
            className="mt-auto bg-slate-900 text-white w-full py-4 rounded-xl font-bold text-lg hover:bg-slate-800 transition focus:outline-none focus:ring-2 focus:ring-slate-400"
            onClick={() => setShowAnswer(true)}
          >
            显示答案
          </button>
        )}
      </div>
    </div>
  );
}

function RateButton({
  label,
  hint,
  color,
  onClick,
}: {
  label: string;
  hint: string;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`py-3 rounded-xl font-bold transition-transform active:scale-95 flex flex-col items-center ${color}`}
    >
      <span>{label}</span>
      <span className="text-[10px] font-medium opacity-70 mt-0.5">{hint}</span>
    </button>
  );
}

// ==========================================================================
// 数据中心（基于真实单词本数据统计）
// ==========================================================================
function DashboardWorkspace({ vocab }: { vocab: VocabWord[] }) {
  const total = vocab.length;
  const due = vocab.filter(isDue).length;
  // 掌握：已成功复习 3 次以上
  const mastered = vocab.filter((w) => w.repetitions >= 3).length;
  const avgEase =
    total > 0
      ? (vocab.reduce((s, w) => s + w.easeFactor, 0) / total).toFixed(2)
      : "—";

  const recent = [...vocab]
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .slice(0, 8);

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto w-full overflow-y-auto no-scrollbar">
      <h2 className="text-2xl md:text-3xl font-bold text-slate-800 mb-8">学习数据中心</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-10">
        <StatCard title="总词汇量" value={total} icon={<BookOpen size={24} />} color="bg-blue-50 text-blue-600" />
        <StatCard title="今日待复习" value={due} icon={<RefreshCw size={24} />} color="bg-orange-50 text-orange-600" />
        <StatCard title="已掌握" value={mastered} icon={<CheckCircle size={24} />} color="bg-green-50 text-green-600" />
        <StatCard title="平均熟练度" value={avgEase} icon={<Gauge size={24} />} color="bg-purple-50 text-purple-600" />
      </div>

      <h3 className="text-lg font-bold text-slate-700 mb-4">最近收藏</h3>
      {recent.length === 0 ? (
        <p className="text-slate-400">还没有收藏单词，去学习舱点击字幕里的生词试试。</p>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100">
          {recent.map((w) => (
            <div key={w.id} className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-3">
                <button onClick={() => speak(w.word)} className="text-blue-500" aria-label="朗读">
                  <Volume2 size={16} />
                </button>
                <span className="font-bold text-slate-800">{w.word}</span>
                {w.phonetic && <span className="text-xs text-slate-400 font-mono">{w.phonetic}</span>}
              </div>
              <span className="text-xs text-slate-400">
                {isDue(w) ? "待复习" : `下次 ${new Date(w.nextReviewDate).toLocaleDateString()}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({
  title,
  value,
  icon,
  color,
}: {
  title: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="bg-white p-5 md:p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4 hover:-translate-y-1 transition-transform">
      <div className={`p-3 md:p-4 rounded-xl ${color}`}>{icon}</div>
      <div>
        <div className="text-slate-500 font-medium text-sm">{title}</div>
        <div className="text-2xl md:text-3xl font-bold text-slate-800">{value}</div>
      </div>
    </div>
  );
}

// ==========================================================================
// 共用 UI
// ==========================================================================
function NavItem({
  icon,
  label,
  active,
  onClick,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-colors font-medium focus:outline-none focus:ring-2 focus:ring-blue-400 ${
        active ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-50"
      }`}
    >
      {icon} <span>{label}</span>
      {!!badge && badge > 0 && (
        <span className="ml-auto bg-red-100 text-red-600 text-xs py-0.5 px-2 rounded-full font-bold">
          {badge}
        </span>
      )}
    </button>
  );
}

function EmptyState({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-slate-500 px-6 text-center">
      {icon}
      <h2 className="text-2xl font-bold text-slate-800">{title}</h2>
      <p className="mt-2 text-slate-400">{desc}</p>
    </div>
  );
}
