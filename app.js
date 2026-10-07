/**
 * 今日吃什麼 - 日系轉盤 (Japanese Food Roulette Web App)
 * 核心特色：
 * 1. 25 種具體單一美食品項（支援自訂與勾選啟用）
 * 2. 物理減速轉盤、指針微動效與純 Web Audio 木質微點擊聲
 * 3. 原生 GPS 定位與彈性距離滑桿（500m ~ 3000m）
 * 4. 周邊真實店家搜尋（OpenStreetMap / Overpass API 免金鑰，由近到遠排序）
 * 5. Google Maps 深度連結導航
 * 6. 3 天歷史記憶追蹤與「前 1、2、3 天已吃過」標籤＋避雷重轉機制
 * 7. 全面落實 DOM 安全防護（嚴格使用 textContent 防範 XSS）
 */

// ==========================================================================
// 1. 預設 20 種具體正餐美食品項與傳統和風配色
// ==========================================================================
const DEFAULT_ITEMS = [
  "便當", "定食", "炒飯", "炒麵", "牛肉麵",
  "拉麵", "義大利麵", "咖哩飯", "丼飯", "火鍋",
  "鐵板燒", "滷肉飯", "雞肉飯", "鴨肉飯", "健康餐",
  "水餃", "早午餐", "壽司", "漢堡", "披薩"
];

// 日系和風柔和色票（練色、白綠、洗朱、藤鼠、薄梅鼠、甕覗、鳥子色、利休白茶）
const PALETTE = [
  "#F5EFEB", "#E8EFEA", "#FDF1E7", "#ECE9F2", 
  "#F7EAE6", "#EBF2F6", "#F9F3DE", "#EFE8DF",
  "#F1ECE6", "#E5ECE6", "#FCEEE2", "#E9E5EE"
];

// ==========================================================================
// 2. 應用程式狀態管理 (Application State)
// ==========================================================================
const State = {
  // 轉盤品項（已啟用）
  activeItems: [],
  // 完整品項庫（可自訂）
  allCustomItems: [],
  // 旋轉狀態
  isSpinning: false,
  currentAngle: 0,
  selectedItem: null,
  // 使用者座標
  userLocation: null, // { lat: number, lon: number }
  isLocating: false,
  // 搜尋生活圈半徑 (公尺，5 公里生活圈)
  radius: 5000,
  // 歷史紀錄資料庫 key
  STORAGE_HISTORY_KEY: "eating_history_records_v1",
  STORAGE_CUSTOM_ITEMS_KEY: "eating_custom_items_v4",
  // 本地已存歷史 [{ name: string, category: string, timestamp: number }]
  history: []
};

// ==========================================================================
// 3. 網頁音訊合成器 (Web Audio API - 純程式產生木質指針敲擊音)
// ==========================================================================
class SoundFX {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  playTick() {
    try {
      this.init();
      if (!this.ctx) return;
      
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = "sine";
      // 模擬木質輕巧碰撞敲擊頻率 (520Hz 快速衰減)
      osc.frequency.setValueAtTime(560, now);
      osc.frequency.exponentialRampToValueAtTime(140, now + 0.035);

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.04);
    } catch (e) {
      // 靜音環境安全容錯
    }
  }
}

const soundFX = new SoundFX();

// ==========================================================================
// 4. 歷史記憶計算器 (3 天內紀錄與天數標籤)
// ==========================================================================
const HistoryManager = {
  load() {
    try {
      const raw = localStorage.getItem(State.STORAGE_HISTORY_KEY);
      State.history = raw ? JSON.parse(raw) : [];
      this.cleanExpired();
    } catch (e) {
      State.history = [];
    }
  },

  save() {
    try {
      localStorage.setItem(State.STORAGE_HISTORY_KEY, JSON.stringify(State.history));
    } catch (e) {
      console.warn("無法寫入 localStorage", e);
    }
  },

  // 清除超過 7 天的舊紀錄，維護本地儲存空間
  cleanExpired() {
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    State.history = State.history.filter(item => (now - item.timestamp) < sevenDaysMs);
    this.save();
  },

  // 新增用餐紀錄
  addRecord(restaurantName, category) {
    const newRecord = {
      id: "eat_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      name: restaurantName,
      category: category,
      timestamp: Date.now()
    };
    // 加在最前面
    State.history.unshift(newRecord);
    this.save();
  },

  // 取得某餐廳或品項在 3 天內的吃過天數狀態
  // 回傳: { eaten: boolean, daysAgo: number, label: string }
  checkEatenStatus(restaurantName, category) {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    // 依名稱或品項匹配最接近的一次
    const match = State.history.find(h => {
      const nameMatch = restaurantName && h.name && h.name.trim() === restaurantName.trim();
      const catMatch = category && h.category && h.category === category;
      return nameMatch || catMatch;
    });

    if (!match) {
      return { eaten: false, daysAgo: null, label: null };
    }

    const diffDays = Math.floor((now - match.timestamp) / oneDayMs);

    // 0 = 今天 (前 1 天內), 1 = 昨天 (前 1 天), 2 = 前 2 天, 3 = 前 3 天
    if (diffDays <= 3) {
      let label = "";
      if (diffDays === 0) {
        label = "今天已吃過";
      } else {
        label = `前 ${diffDays} 天已吃過`;
      }
      return { eaten: true, daysAgo: diffDays, label: label };
    }

    return { eaten: false, daysAgo: null, label: null };
  },

  clearAll() {
    State.history = [];
    localStorage.removeItem(State.STORAGE_HISTORY_KEY);
  }
};

// ==========================================================================
// 5. 轉盤 Canvas 渲染器 (Wheel Canvas Renderer)
// ==========================================================================
class RouletteWheel {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext("2d");
    this.lastTickIndex = -1;
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 2;
    const rect = this.canvas.getBoundingClientRect();
    const size = rect.width || 320;
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.ctx.scale(dpr, dpr);
    this.size = size;
    this.radius = size / 2;
    this.draw(State.currentAngle);
  }

  draw(angleRad = 0) {
    const items = State.activeItems;
    const total = items.length;
    if (total === 0) return;

    const ctx = this.ctx;
    const r = this.radius;
    const arc = (2 * Math.PI) / total;

    ctx.clearRect(0, 0, this.size, this.size);

    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(angleRad);

    // 繪製各扇形區塊
    for (let i = 0; i < total; i++) {
      const sliceStart = i * arc;
      const sliceEnd = (i + 1) * arc;

      // 扇形底色
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r - 3, sliceStart, sliceEnd);
      ctx.closePath();
      ctx.fillStyle = PALETTE[i % PALETTE.length];
      ctx.fill();

      // 細緻米白分割線
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 繪製外向放射狀文字
      ctx.save();
      const textAngle = sliceStart + arc / 2;
      ctx.rotate(textAngle);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      
      // 字體大小隨品項數量動態微調
      const fontSize = total > 20 ? 11 : 13;
      ctx.font = `600 ${fontSize}px "Zen Maru Gothic", "Noto Sans TC", sans-serif`;
      ctx.fillStyle = "#2C2825";

      // 檢查該品項 3 天內是否有吃過，若有吃過字體標註小綠點
      const eatenCheck = HistoryManager.checkEatenStatus(null, items[i]);
      let displayText = items[i];
      if (eatenCheck.eaten) {
        displayText = "• " + items[i];
      }

      ctx.fillText(displayText, r - 16, 0);
      ctx.restore();
    }

    // 外環木質細緻光澤
    ctx.beginPath();
    ctx.arc(0, 0, r - 2, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(184, 139, 88, 0.4)";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.restore();
  }

  // 取得目前指針（正上方 12 點鐘方向，角度為 -Math.PI / 2）對應的選中品項
  getCurrentSelectedItem(angleRad) {
    const items = State.activeItems;
    const total = items.length;
    if (total === 0) return null;

    const arc = (2 * Math.PI) / total;
    // 指針在正上方 (相當於 -PI/2 或 3*PI/2)
    // 轉盤順時針旋轉 angleRad，求指針指到的扇形 index
    const pointerAngle = (3 * Math.PI / 2 - (angleRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const index = Math.floor(pointerAngle / arc) % total;
    return items[index];
  }
}

let wheel = null;

// ==========================================================================
// 6. 轉盤旋轉物理動效 (Physics Spin Animation)
// ==========================================================================
function spinRoulette() {
  if (State.isSpinning || State.activeItems.length === 0) return;

  State.isSpinning = true;
  document.getElementById("centerSpinBtn").classList.add("spinning");

  // 播放點擊音效
  soundFX.playTick();
  if (navigator.vibrate) navigator.vibrate(15);

  // 隱藏前次結果與清單
  document.getElementById("resultContainer").style.display = "none";
  document.getElementById("restaurantsSection").style.display = "none";

  const total = State.activeItems.length;
  const arc = (2 * Math.PI) / total;

  // 隨機選定多圈旋轉量 (4 到 7 圈) + 隨機偏移角
  const randomRounds = 4 + Math.random() * 3;
  const targetOffset = Math.random() * (2 * Math.PI);
  const totalRotation = randomRounds * 2 * Math.PI + targetOffset;

  const startAngle = State.currentAngle;
  const finalAngle = startAngle + totalRotation;
  const duration = 3800; // 3.8 秒減速
  const startTime = performance.now();

  let lastSectorIndex = -1;
  const pointerEl = document.getElementById("wheelPointer");

  function animate(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // 三次立方緩出曲線 (Cubic Ease-Out) 營造優雅慣性減速
    const easeProgress = 1 - Math.pow(1 - progress, 3);
    const currentAngle = startAngle + totalRotation * easeProgress;
    State.currentAngle = currentAngle;

    wheel.draw(currentAngle);

    // 計算指針經過的扇形，觸發木質點擊聲與指針晃動
    const currentItem = wheel.getCurrentSelectedItem(currentAngle);
    const currentIndex = State.activeItems.indexOf(currentItem);
    if (currentIndex !== lastSectorIndex && currentIndex !== -1) {
      lastSectorIndex = currentIndex;
      soundFX.playTick();
      if (navigator.vibrate && progress < 0.8) navigator.vibrate(8);
      
      // 指針微晃動畫
      pointerEl.classList.add("tick");
      setTimeout(() => pointerEl.classList.remove("tick"), 60);
    }

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      State.isSpinning = false;
      document.getElementById("centerSpinBtn").classList.remove("spinning");
      
      // 正式選中品項
      const finalItem = wheel.getCurrentSelectedItem(finalAngle);
      State.selectedItem = finalItem;
      onRouletteFinish(finalItem);
    }
  }

  requestAnimationFrame(animate);
}

// 轉盤停止時的處理
function onRouletteFinish(selectedItem) {
  if (navigator.vibrate) navigator.vibrate([20, 40, 30]);

  // 檢查該品項 3 天內是否已吃過
  const eatenStatus = HistoryManager.checkEatenStatus(null, selectedItem);

  renderResultCard(selectedItem, eatenStatus);

  // 查詢周邊店家
  searchNearbyRestaurants(selectedItem);
}

// ==========================================================================
// 7. 渲染結果卡片與 3 天已吃過溫馨避雷橫幅
// ==========================================================================
function renderResultCard(item, eatenStatus) {
  const container = document.getElementById("resultContainer");
  container.innerHTML = ""; // 清空容器
  container.style.display = "block";

  const card = document.createElement("div");
  card.className = "result-card";

  // 頂部日系標籤
  const tag = document.createElement("div");
  tag.className = "result-tag";
  tag.textContent = "今日のごはん";
  card.appendChild(tag);

  // 食物品項名稱
  const nameEl = document.createElement("h2");
  nameEl.className = "result-food-name";
  nameEl.textContent = item;
  card.appendChild(nameEl);

  // 說明文案
  const descEl = document.createElement("p");
  descEl.className = "result-desc";
  descEl.textContent = "轉盤為您決定了今天這餐！以下是周邊由近到遠的餐廳推薦：";
  card.appendChild(descEl);

  // 若 3 天內曾吃過，顯示避雷警示卡片
  if (eatenStatus.eaten) {
    const alertBanner = document.createElement("div");
    alertBanner.className = "eaten-alert-banner";

    const alertHeader = document.createElement("div");
    alertHeader.className = "alert-header";

    const warnIcon = document.createElement("span");
    warnIcon.textContent = "⚠️";
    const warnText = document.createElement("span");
    warnText.textContent = "溫馨提示：您在 ";
    const strongLabel = document.createElement("strong");
    strongLabel.textContent = eatenStatus.label;
    const endText = document.createElement("span");
    endText.textContent = "！";

    warnText.appendChild(strongLabel);
    warnText.appendChild(endText);
    alertHeader.appendChild(warnIcon);
    alertHeader.appendChild(warnText);
    alertBanner.appendChild(alertHeader);

    const alertActions = document.createElement("div");
    alertActions.className = "alert-actions";

    const reSpinBtn = document.createElement("button");
    reSpinBtn.className = "btn-primary-sm";
    reSpinBtn.textContent = "避雷！再轉一次";
    reSpinBtn.onclick = () => {
      spinRoulette();
    };

    const keepBtn = document.createElement("button");
    keepBtn.className = "btn-secondary-sm";
    keepBtn.textContent = "就是想再吃！";
    keepBtn.onclick = () => {
      alertBanner.style.display = "none";
    };

    alertActions.appendChild(reSpinBtn);
    alertActions.appendChild(keepBtn);
    alertBanner.appendChild(alertActions);

    card.appendChild(alertBanner);
  }

  container.appendChild(card);
  // 平滑滾動至結果
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ==========================================================================
// 8. 原生 GPS 定位與距離計算 (Geolocation & Haversine Formula)
// ==========================================================================
function initLocation() {
  const dot = document.getElementById("locationStatusDot");
  const text = document.getElementById("locationStatusText");

  if (!navigator.geolocation) {
    text.textContent = "此裝置不支援定位";
    return;
  }

  State.isLocating = true;
  text.textContent = "正在獲取 GPS 定位...";

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      State.isLocating = false;
      State.userLocation = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude
      };
      dot.classList.add("active");
      text.textContent = "GPS 定位成功（依距離排序中）";
      showToast("📍 定位成功！已啟用周邊店家距離排序");
    },
    (err) => {
      State.isLocating = false;
      dot.classList.remove("active");
      text.textContent = "未允許定位 (使用預設導航搜尋)";
      console.warn("Geolocation 取得失敗:", err.message);
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
}

// 計算兩經緯度點直線距離 (公尺) - Haversine Formula
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // 地球半徑 (公尺)
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function formatDistance(meters) {
  if (meters < 1000) {
    return `約 ${Math.round(meters)} 公尺`;
  }
  return `約 ${(meters / 1000).toFixed(1)} 公里`;
}

// ==========================================================================
// 9. 23 類正餐精準關鍵字典與店家過濾規則 (Precision Dictionary & Filter)
// ==========================================================================
const CATEGORY_SEARCH_MAP = {
  "便當": {
    queries: ["便當", "排骨", "快餐", "燒臘", "池上", "正忠", "悟饕", "梁社漢"],
    matches: ["便當", "快餐", "燒臘", "排骨", "飯包", "餐盒", "池上", "正忠", "悟饕", "知高", "控肉", "爌肉", "便當店", "梁社漢", "金仙"],
    excludes: ["咖啡", "甜點", "飲料", "手搖", "麵包", "早午餐", "火鍋", "冰品", "豆花"]
  },
  "定食": {
    queries: ["定食", "日式定食", "日式料理", "大戶屋", "定食8", "勝博殿"],
    matches: ["定食", "和食", "料理", "食堂", "丼", "日料", "大戶屋", "定食8", "日本料理", "勝博殿", "福勝亭"],
    excludes: ["咖啡", "甜點", "飲料", "麵包", "早午餐", "早餐", "手搖"]
  },
  "炒飯": {
    queries: ["炒飯", "熱炒", "炒館", "快炒"],
    matches: ["炒飯", "熱炒", "快炒", "小吃", "炒館", "炒麵炒飯"],
    excludes: ["咖啡", "甜點", "飲料", "麵包", "早午餐", "義大利麵", "披薩"]
  },
  "炒麵": {
    queries: ["炒麵", "意麵", "鱔魚", "熱炒"],
    matches: ["炒麵", "鱔魚", "意麵", "熱炒", "快炒", "炒館"],
    excludes: ["咖啡", "甜點", "飲料", "麵包", "早午餐", "漢堡"]
  },
  "牛肉麵": {
    queries: ["牛肉麵", "牛肉", "刀削牛肉麵", "三商巧福"],
    matches: ["牛肉麵", "牛肉", "刀削", "麵食", "清燉牛肉", "紅燒牛肉", "老張", "段純貞", "三商巧福", "牛肉館"],
    excludes: ["咖啡", "甜點", "飲料", "麵包", "披薩", "漢堡", "早午餐", "冰品"]
  },
  "拉麵": {
    queries: ["拉麵", "ラーメン", "豚骨", "麵屋"],
    matches: ["拉麵", "ラーメン", "豚骨", "雞白湯", "沾麵", "一蘭", "花月嵐", "屯京", "隱家", "麵屋", "鳥人"],
    excludes: ["咖啡", "甜點", "飲料", "麵包", "火鍋", "早午餐", "牛肉麵"]
  },
  "義大利麵": {
    queries: ["Pasta", "義大利麵", "義式料理", "義麵"],
    matches: ["義大利麵", "義式", "Pasta", "義麵", "斜管麵", "Spaghetti", "pasta"],
    excludes: ["牛肉麵", "拉麵", "陽春麵", "手搖", "甜點", "麵包", "便當", "熱炒"]
  },
  "咖哩飯": {
    queries: ["咖哩", "カレー", "Curry", "咖喱"],
    matches: ["咖哩", "カレー", "Curry", "咖喱", "壹番屋", "curry"],
    excludes: ["火鍋", "甜點", "手搖", "麵包", "水餃", "熱炒"]
  },
  "丼飯": {
    queries: ["丼", "すき家", "吉野家", "燒肉丼"],
    matches: ["丼", "どんぶり", "吉野家", "すき家", "Sukiya", "sukiya", "松屋", "燒肉丼", "親子丼"],
    excludes: ["咖啡", "甜點", "手搖", "麵包", "火鍋", "水餃"]
  },
  "火鍋": {
    queries: ["火鍋", "小火鍋", "涮涮鍋", "石二鍋"],
    matches: ["火鍋", "小火鍋", "鍋物", "涮涮鍋", "麻辣鍋", "石頭火鍋", "石二鍋", "六扇門", "錢都", "築間", "肉多多", "三媽", "涮涮", "鍋"],
    excludes: ["咖啡", "甜點", "手搖", "麵包", "早午餐", "漢堡", "拉麵", "牛排", "義大利麵", "大樓", "百貨"]
  },
  "鐵板燒": {
    queries: ["鐵板", "大埔鐵板燒", "鐵板燒", "Teppanyaki"],
    matches: ["鐵板", "鐵板燒", "大埔", "犇", "teppanyaki", "Teppanyaki"],
    excludes: ["火鍋", "拉麵", "咖啡", "甜點", "手搖", "麵包"]
  },
  "滷肉飯": {
    queries: ["滷肉", "魯肉", "肉燥飯", "滷肉飯"],
    matches: ["滷肉飯", "魯肉飯", "肉燥飯", "小吃", "魯肉", "滷肉", "鬍鬚張", "金峰", "肉燥"],
    excludes: ["義大利麵", "披薩", "漢堡", "拉麵", "咖啡", "甜點", "手搖"]
  },
  "雞肉飯": {
    queries: ["雞肉", "火雞肉飯", "雞肉飯", "梁社漢"],
    matches: ["雞肉飯", "火雞肉飯", "火雞肉", "雞肉", "梁社漢", "海南雞"],
    excludes: ["咖啡", "甜點", "手搖", "披薩", "漢堡", "拉麵"]
  },
  "鴨肉飯": {
    queries: ["鴨肉", "當歸鴨", "鴨肉飯", "鴨肉羹"],
    matches: ["鴨肉", "當歸鴨", "鴨肉羹", "鴨莊", "鴨肉麵", "鴨肉冬粉", "鴨肉扁", "鴨肉珍", "鴨肉富", "鴨肉店", "鴨"],
    excludes: ["咖啡", "甜點", "手搖", "披薩", "漢堡", "拉麵"]
  },
  "健康餐": {
    queries: ["健康餐", "少點鹽", "能量小姐", "隨主飡", "低卡便當", "舒肥", "水煮餐"],
    matches: ["健康餐", "低卡", "舒肥", "水煮", "低GI", "蛋白", "少油低卡", "能量盒", "健康便當", "少點鹽", "能量小姐", "隨主飡", "健康餐盒", "低gi"],
    excludes: ["油炸", "火鍋", "甜點", "手搖", "咖啡", "炸雞", "飲料"]
  },
  "水餃": {
    queries: ["水餃", "八方雲集", "四海遊龍", "鍋貼", "餃子"],
    matches: ["水餃", "餃子", "鍋貼", "八方雲集", "四海遊龍", "水餃館", "蒸餃", "餃", "煎餃"],
    excludes: ["咖啡", "甜點", "手搖", "五金", "服飾", "義大利麵", "漢堡"]
  },
  "早午餐": {
    queries: ["Brunch", "早午", "早午餐", "貳樓"],
    matches: ["早午", "早午餐", "brunch", "Brunch", "盤餐", "拼盤", "貳樓", "濰克", "6吋盤", "六吋盤", "輕食", "全日早午餐", "早午餐盤", "咖啡早午餐", "好初", "豐滿", "樂子", "光合箱子"],
    excludes: ["美而美", "美芝城", "弘爺", "拉亞", "晨間廚房", "麥味登", "永和豆漿", "豆漿", "早點", "早餐店", "純早餐", "熱炒", "火鍋", "燒烤", "便當", "鐵板燒", "牛肉麵"]
  },
  "壽司": {
    queries: ["壽司", "爭鮮", "藏壽司", "壽司郎", "迴轉壽司"],
    matches: ["壽司", "すし", "Sushi", "sushi", "爭鮮", "壽司郎", "藏壽司", "くら寿司", "握壽司", "日式料理", "生魚片"],
    excludes: ["咖啡", "甜點", "手搖", "麵包", "牛肉麵", "火鍋", "便當"]
  },
  "漢堡": {
    queries: ["漢堡", "麥當勞", "肯德基", "摩斯漢堡", "漢堡王", "SUBWAY"],
    matches: ["漢堡", "Burger", "burger", "麥當勞", "肯德基", "摩斯漢堡", "漢堡王", "SUBWAY", "subway", "美式"],
    excludes: ["水餃", "火鍋", "滷肉飯", "牛肉麵", "熱炒", "便當"]
  },
  "披薩": {
    queries: ["披薩", "必勝客", "達美樂", "拿坡里", "Pizza"],
    matches: ["披薩", "比薩", "Pizza", "pizza", "必勝客", "達美樂", "拿坡里", "窯烤披薩"],
    excludes: ["火鍋", "拉麵", "牛肉麵", "滷肉飯", "便當", "甜點", "手搖"]
  }
};

// 檢查是否為合法餐飲設施（剔除大樓、村莊、交流道、診所等雜質）
function isDiningAmenity(item) {
  if (!item) return true;
  const diningTypes = ["restaurant", "fast_food", "cafe", "food_court", "bistro", "pub", "bar"];
  if (diningTypes.includes(item.type)) return true;
  if (item.class === "amenity") return true;

  // 明確排除非餐飲地標（如建築、交通、地理、村莊、診所、體育用品等）
  const nonDiningTypes = ["building", "village", "hamlet", "motorway_junction", "peak", "clinic", "sports", "apartments", "suburb", "town", "place", "highway"];
  if (nonDiningTypes.includes(item.type) || nonDiningTypes.includes(item.class)) return false;

  const name = (item.name || "").toLowerCase();
  if (/餐廳|飯館|食堂|小吃|店|館|坊|廚房|料理|餐盒|麵|鍋|快炒|熱炒/.test(name)) return true;
  return false;
}

// 檢查是否為已歇業、廢棄或停業店家
function isClosedOrDisused(item, rawName) {
  const textToCheck = `${rawName} ${item.display_name || ""} ${item.type || ""} ${item.class || ""}`.toLowerCase();
  const closedMarkers = [
    "已歇業", "歇業", "永久停業", "停業", "已關閉", "搬遷", "暫停營業", "頂讓", "招租",
    "disused", "abandoned", "vacant", "closed", "permanently closed"
  ];
  if (closedMarkers.some(marker => textToCheck.includes(marker))) {
    return true;
  }
  if (item.extratags) {
    if (item.extratags.disused === "yes" || item.extratags.abandoned === "yes") return true;
    if (item.extratags.operational_status === "closed_permanently") return true;
  }
  return false;
}

// 嚴格審查店家準確度：餐飲設施檢查 + 通用排除 + 專屬排除 + 特徵詞吻合驗證
function matchesCategoryPrecision(rawName, displayName, category, item) {
  // 1. 餐飲設施審查：非餐飲地標一律剔除
  if (item && !isDiningAmenity(item)) {
    return false;
  }

  const fullName = `${rawName} ${displayName || ""}`.toLowerCase();

  // 2. 通用排除名單（純手搖店、便利超商、醫療院所、五金等非正餐雜質）
  const commonExcludes = [
    "50嵐", "五十嵐", "清心福全", "麻古茶坊", "迷客夏", "可不可熟成紅茶", "茶湯會", "珍煮丹", "烏弄",
    "得正", "一沐日", "五桐號", "龜記", "再睡5分鐘", "先喝道", "大苑子", "CoCo都可", "鮮茶道",
    "7-eleven", "7-11", "全家便利", "萊爾富", "ok便利", "全聯", "家樂福", "美廉社",
    "藥局", "診所", "中醫", "眼科", "牙醫", "彩券", "機車行", "汽車修配", "五金行", "迪卡儂",
    "屈臣氏", "康是美", "寶雅", "蝦皮店到店"
  ];
  if (commonExcludes.some(ex => fullName.includes(ex.toLowerCase()))) {
    return false;
  }

  const rule = CATEGORY_SEARCH_MAP[category];
  if (!rule) {
    return true;
  }

  // 3. 品項專屬排除關鍵字
  if (rule.excludes && rule.excludes.some(ex => fullName.includes(ex.toLowerCase()))) {
    return false;
  }

  // 4. 特徵詞吻合驗證（Must Match）：店名或餐飲標籤必須命中該料理特徵或代表品牌，徹底消除無關選項
  if (rule.matches && rule.matches.length > 0) {
    const rawLower = rawName.toLowerCase();
    const cuisineTag = (item && item.extratags && item.extratags.cuisine ? item.extratags.cuisine.toLowerCase() : "");
    const hit = rule.matches.some(m => {
      const mLow = m.toLowerCase();
      return rawLower.includes(mLow) || (cuisineTag && cuisineTag.includes(mLow));
    });
    if (!hit) {
      return false; // 店名與餐飲標籤皆不相干者剔除
    }
  }

  return true;
}

// 取得命中特徵詞（用於前端呈現準確度驗證標籤）
function getMatchedFeatureKeyword(rawName, category) {
  const rule = CATEGORY_SEARCH_MAP[category];
  if (!rule || !rule.matches) return category;
  const rawLower = rawName.toLowerCase();
  for (const m of rule.matches) {
    if (rawLower.includes(m.toLowerCase())) {
      if (m === "早午" || m === "早午餐") return "精選早午餐";
      if (m === "brunch" || m === "Brunch") return "Brunch 輕食早午餐";
      if (m === "盤餐" || m === "拼盤" || m === "早午餐盤" || m === "6吋盤" || m === "六吋盤") return "早午餐盤套餐";
      if (m === "貳樓") return "貳樓早午餐";
      if (m === "鐵板") return "鐵板燒";
      if (m === "牛肉") return "牛肉料理";
      if (m === "鴨肉") return "鴨肉料理";
      if (m === "雞肉") return "雞肉料理";
      if (m === "滷肉" || m === "魯肉") return "滷肉飯";
      return m;
    }
  }
  return category;
}

// 清洗與格式化台灣地址路段字串
function formatCleanAddress(displayName) {
  if (!displayName) return "";
  const parts = displayName.split(",").map(s => s.trim());
  const relevant = parts.filter(p => /路|街|巷|段|區|市|鎮|鄉/.test(p) && !/臺灣|台灣|\d{5,6}/.test(p));
  if (relevant.length > 0) {
    return relevant.slice(0, 2).reverse().join(" · ");
  }
  return parts.slice(1, 3).join(" · ");
}

// 單一關鍵字搜尋 Nominatim
async function fetchNominatimPlaces(queryTerm, viewbox, signal) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(queryTerm)}&countrycodes=tw&viewbox=${viewbox}&bounded=0&limit=25`;
  try {
    const res = await fetch(url, { signal, headers: { "Accept": "application/json" } });
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    // 忽略個別超時，交由整體流程匯總
  }
  return [];
}

// ==========================================================================
// 10. 周邊真實店家搜尋 (嚴格 8 公里硬上限 + 停業過濾 + 零落差字典匹配)
// ==========================================================================
async function searchNearbyRestaurants(category) {
  const section = document.getElementById("restaurantsSection");
  const listEl = document.getElementById("restaurantList");
  const countEl = document.getElementById("searchCount");

  section.style.display = "flex";
  listEl.innerHTML = "";

  // 若使用者尚未取得 GPS 位置，提示並提供直接 Google Maps 按鈕
  if (!State.userLocation) {
    countEl.textContent = "";

    const emptyBox = document.createElement("div");
    emptyBox.className = "empty-box";

    const p1 = document.createElement("p");
    p1.textContent = "尚未開啟手機 GPS 定位權限";

    const p2 = document.createElement("p");
    p2.style.fontSize = "12px";
    p2.style.color = "#8C827A";
    p2.textContent = `點擊下方按鈕可直接以 Google Maps App 搜尋您周邊 5 公里內的【${category}】`;

    const gmapsLink = document.createElement("a");
    gmapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('附近 ' + category)}`;
    gmapsLink.target = "_blank";
    gmapsLink.rel = "noopener noreferrer";
    gmapsLink.className = "direct-gmaps-fallback";

    const mapIcon = document.createElement("span");
    mapIcon.textContent = "🗺️ ";
    const mapText = document.createElement("span");
    mapText.textContent = `前往 Google Maps 搜尋周邊【${category}】`;
    gmapsLink.appendChild(mapIcon);
    gmapsLink.appendChild(mapText);

    emptyBox.appendChild(p1);
    emptyBox.appendChild(p2);
    emptyBox.appendChild(gmapsLink);
    listEl.appendChild(emptyBox);
    return;
  }

  // 顯示載入動畫
  const loadingBox = document.createElement("div");
  loadingBox.className = "loading-box";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  const pLoading = document.createElement("p");
  pLoading.textContent = `正在為您搜尋 5 公里生活圈內的【${category}】店家...`;
  loadingBox.appendChild(spinner);
  loadingBox.appendChild(pLoading);
  listEl.appendChild(loadingBox);

  const { lat, lon } = State.userLocation;
  const delta = 0.05; // 約 5 公里生活圈視窗
  const viewbox = `${lon - delta},${lat + delta},${lon + delta},${lat - delta}`;
  const maxDistanceMeters = 5000; // 最遠 5 公里硬上限

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000);

  const rule = CATEGORY_SEARCH_MAP[category] || { queries: [category] };
  const queryList = rule.queries || [category];

  const seenIds = new Set();
  const validRestaurants = [];

  try {
    // 1. 同時並行查詢前 4 個熱門核心關鍵字，大幅提高命中率與完整度 (採用 Promise.allSettled 確保高容錯)
    const searchPromises = queryList.slice(0, 4).map(term => 
      fetchNominatimPlaces(term, viewbox, controller.signal)
    );
    const settledResults = await Promise.allSettled(searchPromises);
    const searchResultsArrays = settledResults
      .filter(r => r.status === "fulfilled" && Array.isArray(r.value))
      .map(r => r.value);

    for (const dataList of searchResultsArrays) {
      for (const item of dataList) {
        const itemLat = parseFloat(item.lat);
        const itemLon = parseFloat(item.lon);
        if (isNaN(itemLat) || isNaN(itemLon)) continue;

        const dist = calculateDistanceMeters(lat, lon, itemLat, itemLon);
        // 嚴格限制：超過 5 公里立即捨棄
        if (dist > maxDistanceMeters) continue;

        const rawName = item.name || (item.display_name ? item.display_name.split(",")[0].trim() : "");
        if (!rawName) continue;

        // 過濾已歇業或停業
        if (isClosedOrDisused(item, rawName)) continue;

        // 過濾非餐飲雜質與不吻合店家
        if (!matchesCategoryPrecision(rawName, item.display_name, category, item)) continue;

        const uniqueKey = `${rawName.replace(/\s+/g, "")}_${itemLat.toFixed(3)}_${itemLon.toFixed(3)}`;
        if (seenIds.has(uniqueKey)) continue;
        seenIds.add(uniqueKey);

        const matchedKeyword = getMatchedFeatureKeyword(rawName, category);

        validRestaurants.push({
          name: rawName,
          lat: itemLat,
          lon: itemLon,
          distance: dist,
          address: formatCleanAddress(item.display_name),
          cuisine: category,
          matchedKeyword: matchedKeyword
        });
      }
    }
  } catch (err) {
    console.warn("店家查詢失敗或逾時:", err);
  } finally {
    clearTimeout(timeoutId);
  }

  // 依距離由近到遠嚴格排序 (Nearest First)
  validRestaurants.sort((a, b) => a.distance - b.distance);

  // 取前 15 間最佳匹配店家，避免畫面過長
  const finalResults = validRestaurants.slice(0, 15);

  renderRestaurantCards(finalResults, category);
}

// 渲染餐廳清單卡片 (安全純原生 DOM textContent 注入，零 XSS 風險)
function renderRestaurantCards(restaurants, category) {
  const listEl = document.getElementById("restaurantList");
  const countEl = document.getElementById("searchCount");
  listEl.innerHTML = "";

  // 置頂推薦 Google Maps 快捷卡片
  const gmapsTargetQuery = category === "早午餐" ? "附近 早午餐 盤餐" : `附近 ${category}`;
  const heroCard = document.createElement("a");
  heroCard.className = "hero-gmaps-card";
  heroCard.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(gmapsTargetQuery)}`;
  heroCard.target = "_blank";
  heroCard.rel = "noopener noreferrer";

  const heroInfo = document.createElement("div");
  heroInfo.style.display = "flex";
  heroInfo.style.flexDirection = "column";
  heroInfo.style.gap = "3px";

  const heroTitle = document.createElement("div");
  heroTitle.style.fontSize = "13px";
  heroTitle.style.fontWeight = "700";
  heroTitle.style.color = "#7A5123";
  heroTitle.textContent = `🌟 開啟 Google Maps 周邊【${category}】人氣排行榜 ↗`;

  const heroSub = document.createElement("div");
  heroSub.style.fontSize = "11px";
  heroSub.style.color = "#8C827A";
  heroSub.textContent = category === "早午餐" ? "查看 Google 網友高評分的早午餐盤餐、歐姆蛋拼盤與名店推薦" : "查看 Google 官方推薦的網友高評分、最新熱門榜與營業時間";

  heroInfo.appendChild(heroTitle);
  heroInfo.appendChild(heroSub);

  const heroArrow = document.createElement("span");
  heroArrow.style.fontSize = "16px";
  heroArrow.style.color = "#B88B58";
  heroArrow.textContent = "➔";

  heroCard.appendChild(heroInfo);
  heroCard.appendChild(heroArrow);
  listEl.appendChild(heroCard);

  // 若開源地圖未登錄該小吃，無縫切換為 Google Maps 官方即時店家卡，絕不讓使用者撲空
  if (restaurants.length === 0) {
    countEl.textContent = "Google Maps 即時清單";

    const emptyBox = document.createElement("div");
    emptyBox.className = "empty-box";
    emptyBox.style.background = "#FFFFFF";
    emptyBox.style.border = "1.5px solid #EADBC8";
    emptyBox.style.padding = "18px 16px";

    const p1 = document.createElement("p");
    p1.style.fontSize = "15px";
    p1.style.fontWeight = "700";
    p1.style.color = "#2C2825";
    p1.textContent = `📍 已鎖定周邊 5 公里生活圈的【${category}】`;

    const p2 = document.createElement("p");
    p2.style.fontSize = "12px";
    p2.style.color = "#8C827A";
    p2.margin = "6px 0 14px";
    p2.textContent = category === "早午餐" ? "點擊下方立即查看 Google Maps 為您推薦的周邊人氣早午餐盤餐、早午餐咖啡廳與真實評分：" : `因在地小吃大多直接登記於 Google，點擊下方立即查看 Google Maps 為您推薦的周邊營業店家與真實評分：`;

    const gmapsLink = document.createElement("a");
    gmapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(gmapsTargetQuery)}`;
    gmapsLink.target = "_blank";
    gmapsLink.rel = "noopener noreferrer";
    gmapsLink.className = "direct-gmaps-fallback";
    gmapsLink.style.padding = "12px 18px";
    gmapsLink.style.fontSize = "14px";

    const mapIcon = document.createElement("span");
    mapIcon.textContent = "🗺️ ";
    const mapText = document.createElement("span");
    mapText.textContent = `開啟 Google Maps 查看附近所有【${category}】`;
    gmapsLink.appendChild(mapIcon);
    gmapsLink.appendChild(mapText);

    emptyBox.appendChild(p1);
    emptyBox.appendChild(p2);
    emptyBox.appendChild(gmapsLink);
    listEl.appendChild(emptyBox);
    return;
  }

  countEl.textContent = `找到 ${restaurants.length} 間（由近到遠）`;

  restaurants.forEach((r) => {
    const card = document.createElement("div");
    card.className = "restaurant-card";

    // 點擊店家名稱或卡片直接跳轉 Google Maps
    const gmapsQuery = `${r.name} ${r.address || ''} ${r.lat},${r.lon}`;
    const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(gmapsQuery)}`;
    card.title = "點擊開啟 Google Maps 查看店家評價與路線";
    card.onclick = (e) => {
      // 避免點擊「記錄這餐」按鈕時誤跳轉
      if (e.target.closest(".record-eat-btn")) return;
      window.open(googleMapsUrl, "_blank", "noopener,noreferrer");
    };

    // 頂部列
    const topRow = document.createElement("div");
    topRow.className = "card-top-row";

    const titleArea = document.createElement("div");
    titleArea.className = "restaurant-title-area";

    const nameEl = document.createElement("div");
    nameEl.className = "restaurant-name";
    nameEl.textContent = r.name; // 原生安全防護

    // 加入 ↗ 外連圖示
    const linkIcon = document.createElement("span");
    linkIcon.style.fontSize = "13px";
    linkIcon.style.color = "#4285F4";
    linkIcon.textContent = " ↗";
    nameEl.appendChild(linkIcon);
    titleArea.appendChild(nameEl);

    // 地址路段資訊
    if (r.address) {
      const addrEl = document.createElement("div");
      addrEl.className = "card-address";
      addrEl.textContent = `📍 ${r.address}`;
      titleArea.appendChild(addrEl);
    }

    // 點擊提示文字
    const hintText = document.createElement("div");
    hintText.className = "card-jump-hint";
    hintText.textContent = "點擊查看 Google Maps 評價與營業時間 ↗";
    titleArea.appendChild(hintText);

    const badgesArea = document.createElement("div");
    badgesArea.className = "restaurant-badges";

    // 評價金黃標籤
    const ratingBadge = document.createElement("span");
    ratingBadge.className = "rating-badge";
    ratingBadge.textContent = "⭐ 查看 Google 評分與營業中狀態";
    badgesArea.appendChild(ratingBadge);

    // 檢查該餐廳在 3 天內是否已吃過
    const eatenStatus = HistoryManager.checkEatenStatus(r.name, category);
    if (eatenStatus.eaten) {
      const eatenBadge = document.createElement("span");
      eatenBadge.className = "eaten-badge";
      eatenBadge.textContent = `✓ ${eatenStatus.label}`;
      badgesArea.appendChild(eatenBadge);
    }

    if (r.cuisine) {
      const cuisineBadge = document.createElement("span");
      cuisineBadge.className = "cuisine-badge";
      cuisineBadge.textContent = r.cuisine;
      badgesArea.appendChild(cuisineBadge);
    }

    // 準確度特徵比對標籤 (回答祐仁：如何檢查準確度)
    if (r.matchedKeyword) {
      const matchPill = document.createElement("span");
      matchPill.className = "match-pill";
      matchPill.style.fontSize = "11px";
      matchPill.style.color = "#2E6B47";
      matchPill.style.background = "#EAF4EE";
      matchPill.style.border = "1px solid #C4E0CF";
      matchPill.style.padding = "2px 7px";
      matchPill.style.borderRadius = "12px";
      matchPill.style.fontWeight = "600";
      matchPill.textContent = `🎯 命中：${r.matchedKeyword}`;
      badgesArea.appendChild(matchPill);
    }

    titleArea.appendChild(badgesArea);
    topRow.appendChild(titleArea);

    // 距離膠囊 (由近到遠)
    const distPill = document.createElement("div");
    distPill.className = "distance-pill";
    distPill.textContent = formatDistance(r.distance);
    topRow.appendChild(distPill);

    card.appendChild(topRow);

    // 操作按鈕列 (Google Maps 導航 + 決定吃這家！)
    const actionsRow = document.createElement("div");
    actionsRow.className = "card-actions-row";

    // Google Maps 深度連結按鈕 (喚起手機 Google Maps App 導航)
    const mapBtn = document.createElement("a");
    mapBtn.className = "nav-map-btn";
    mapBtn.target = "_blank";
    mapBtn.rel = "noopener noreferrer";
    mapBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}`;
    mapBtn.onclick = (e) => e.stopPropagation();
    
    const navIcon = document.createElement("span");
    navIcon.textContent = "🧭 ";
    const navText = document.createElement("span");
    navText.textContent = "Google Maps 導航";
    mapBtn.appendChild(navIcon);
    mapBtn.appendChild(navText);
    actionsRow.appendChild(mapBtn);

    // 「決定吃這家！」按鈕
    const eatBtn = document.createElement("button");
    eatBtn.className = "record-eat-btn";
    
    const eatIcon = document.createElement("span");
    const eatText = document.createElement("span");

    if (eatenStatus.eaten) {
      eatBtn.classList.add("already-eaten");
      eatIcon.textContent = "✓ ";
      eatText.textContent = "重複踩點";
    } else {
      eatIcon.textContent = "🍚 ";
      eatText.textContent = "決定吃這家！";
    }
    eatBtn.appendChild(eatIcon);
    eatBtn.appendChild(eatText);

    eatBtn.onclick = (e) => {
      e.stopPropagation(); // 阻止卡片冒泡跳轉
      HistoryManager.addRecord(r.name, category);
      eatBtn.classList.add("already-eaten");
      eatBtn.textContent = "";
      const checkSpan = document.createElement("span");
      checkSpan.textContent = "✓ 已記錄此餐";
      eatBtn.appendChild(checkSpan);
      showToast(`🎉 已為您記錄「${r.name}」！未來 3 天內將為您標記。`);
      // 重繪轉盤上的標記小點
      wheel.draw(State.currentAngle);
    };

    actionsRow.appendChild(eatBtn);
    card.appendChild(actionsRow);

    listEl.appendChild(card);
  });
}

// 降級容錯視圖 (若開放資料連線逾時，無縫呈現 Google Maps 搜尋)
function renderFallbackGmapsView(category) {
  const listEl = document.getElementById("restaurantList");
  const countEl = document.getElementById("searchCount");
  countEl.textContent = "Google Maps 直連";
  listEl.innerHTML = "";

  const emptyBox = document.createElement("div");
  emptyBox.className = "empty-box";

  const titleP = document.createElement("p");
  titleP.style.fontSize = "14px";
  titleP.style.fontWeight = "700";
  titleP.style.color = "#2C2825";
  titleP.textContent = "已為您連接 Google Maps";

  const descP = document.createElement("p");
  descP.style.fontSize = "12px";
  descP.style.color = "#7E766D";
  descP.style.margin = "4px 0 10px";
  descP.textContent = `點擊下方按鈕將直接開啟 Google Maps App，依您的當前位置由近到遠尋找附近的【${category}】店家：`;

  const gmapsLink = document.createElement("a");
  gmapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('附近 ' + category)}`;
  gmapsLink.target = "_blank";
  gmapsLink.rel = "noopener noreferrer";
  gmapsLink.className = "direct-gmaps-fallback";
  gmapsLink.style.padding = "12px 22px";
  gmapsLink.style.fontSize = "14px";

  const mapIcon = document.createElement("span");
  mapIcon.textContent = "🧭 ";
  const mapText = document.createElement("span");
  mapText.textContent = `打開 Google Maps 尋找附近【${category}】`;
  gmapsLink.appendChild(mapIcon);
  gmapsLink.appendChild(mapText);

  // 手動記錄區塊
  const manualBox = document.createElement("div");
  manualBox.style.marginTop = "14px";
  manualBox.style.width = "100%";
  manualBox.style.borderTop = "1px dashed #EAE4DA";
  manualBox.style.paddingTop = "12px";

  const manualP = document.createElement("p");
  manualP.style.fontSize = "12px";
  manualP.style.color = "#7E766D";
  manualP.style.marginBottom = "8px";
  manualP.textContent = "踩點後可手動記錄今天的選擇：";

  const inputRow = document.createElement("div");
  inputRow.style.display = "flex";
  inputRow.style.gap = "8px";

  const manualInput = document.createElement("input");
  manualInput.type = "text";
  manualInput.id = "manualRestaurantName";
  manualInput.className = "text-input";
  manualInput.placeholder = "輸入今天吃了哪家店...";
  manualInput.style.fontSize = "13px";
  manualInput.maxLength = 20;

  const manualBtn = document.createElement("button");
  manualBtn.id = "manualRecordBtn";
  manualBtn.className = "btn-add";
  manualBtn.style.whiteSpace = "nowrap";
  manualBtn.textContent = "記錄這餐";
  manualBtn.onclick = () => {
    const name = manualInput.value.trim();
    if (name) {
      HistoryManager.addRecord(name, category);
      showToast(`🎉 已為您記錄「${name}」！`);
      manualInput.value = "";
      wheel.draw(State.currentAngle);
    }
  };

  inputRow.appendChild(manualInput);
  inputRow.appendChild(manualBtn);
  manualBox.appendChild(manualP);
  manualBox.appendChild(inputRow);

  emptyBox.appendChild(titleP);
  emptyBox.appendChild(descP);
  emptyBox.appendChild(gmapsLink);
  emptyBox.appendChild(manualBox);

  listEl.appendChild(emptyBox);
}

// ==========================================================================
// 10. 彈窗管理與設定 (History & Custom Items Modals)
// ==========================================================================
function setupModals() {
  // 歷史紀錄彈窗
  const historyModal = document.getElementById("historyModal");
  document.getElementById("openHistoryBtn").onclick = () => {
    renderHistoryList();
    historyModal.classList.add("active");
  };
  document.getElementById("closeHistoryBtn").onclick = () => {
    historyModal.classList.remove("active");
  };

  // 清除歷史紀錄
  document.getElementById("clearHistoryBtn").onclick = () => {
    if (confirm("確定要清除所有用餐歷史紀錄嗎？")) {
      HistoryManager.clearAll();
      renderHistoryList();
      wheel.draw(State.currentAngle);
      showToast("已清空歷史紀錄");
    }
  };

  // 自訂品項設定彈窗
  const settingsModal = document.getElementById("settingsModal");
  document.getElementById("openSettingsBtn").onclick = () => {
    renderSettingsItems();
    settingsModal.classList.add("active");
  };
  document.getElementById("closeSettingsBtn").onclick = () => {
    settingsModal.classList.remove("active");
  };

  // 新增自訂食物品項 (加入嚴格白名單過濾，防範注入)
  document.getElementById("addCustomItemBtn").onclick = () => {
    const input = document.getElementById("newCustomItemInput");
    const val = input.value.trim();
    if (!val) return;

    // 白名單正則驗證：僅允許中文、英文字母、數字與基本空格，長度 1~10 字
    const safeRegex = /^[\u4e00-\u9fa5a-zA-Z0-9\s]{1,10}$/;
    if (!safeRegex.test(val)) {
      showToast("請輸入有效的菜名（僅限中英文及數字，不含特殊符號）");
      return;
    }

    if (State.allCustomItems.includes(val)) {
      showToast("此品項已存在清單中");
      return;
    }
    State.allCustomItems.push(val);
    State.activeItems.push(val);
    saveCustomItems();
    input.value = "";
    renderSettingsItems();
    wheel.draw(State.currentAngle);
    showToast(`已新增品項「${val}」`);
  };

  // 點擊遮罩關閉
  [historyModal, settingsModal].forEach(m => {
    m.onclick = (e) => {
      if (e.target === m) m.classList.remove("active");
    };
  });
}

function renderHistoryList() {
  const container = document.getElementById("historyListContainer");
  container.innerHTML = "";

  if (State.history.length === 0) {
    container.innerHTML = `<p style="text-align: center; color: #7E766D; font-size: 13px; padding: 20px 0;">尚無用餐歷史紀錄</p>`;
    return;
  }

  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  State.history.forEach((h) => {
    const item = document.createElement("div");
    item.className = "history-item";

    const info = document.createElement("div");
    info.className = "history-item-info";

    const name = document.createElement("div");
    name.className = "history-item-name";
    name.textContent = h.name || h.category;

    const time = document.createElement("div");
    time.className = "history-item-time";
    const dateObj = new Date(h.timestamp);
    time.textContent = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日 · ${h.category}`;

    info.appendChild(name);
    info.appendChild(time);
    item.appendChild(info);

    const diffDays = Math.floor((now - h.timestamp) / oneDayMs);
    const badge = document.createElement("span");
    badge.className = "history-item-badge";
    badge.textContent = diffDays === 0 ? "今天" : `前 ${diffDays} 天`;
    item.appendChild(badge);

    container.appendChild(item);
  });
}

function renderSettingsItems() {
  const container = document.getElementById("settingsItemsContainer");
  container.innerHTML = "";

  State.allCustomItems.forEach((item) => {
    const isChecked = State.activeItems.includes(item);
    const card = document.createElement("div");
    card.className = "item-check-card" + (isChecked ? " checked" : "");
    card.textContent = (isChecked ? "✓ " : "○ ") + item;

    card.onclick = () => {
      if (isChecked) {
        if (State.activeItems.length <= 2) {
          showToast("轉盤至少需要保留 2 個品項");
          return;
        }
        State.activeItems = State.activeItems.filter(i => i !== item);
      } else {
        State.activeItems.push(item);
      }
      saveCustomItems();
      renderSettingsItems();
      wheel.draw(State.currentAngle);
    };

    container.appendChild(card);
  });
}

function saveCustomItems() {
  try {
    localStorage.setItem(State.STORAGE_CUSTOM_ITEMS_KEY, JSON.stringify({
      all: State.allCustomItems,
      active: State.activeItems
    }));
  } catch (e) {
    console.warn("自訂品項寫入失敗", e);
  }
}

function loadCustomItems() {
  const sanitize = (list) => list
    .filter(i => i !== "燉飯" && i !== "蛋包飯" && i !== "烏龍麵")
    .map(i => i === "健康餐盒" ? "健康餐" : i);

  try {
    // 優先讀取 v4，若無則讀取舊版 v3 / v2 進行自動無縫遷移
    const raw = localStorage.getItem(State.STORAGE_CUSTOM_ITEMS_KEY) || 
                localStorage.getItem("eating_custom_items_v3") || 
                localStorage.getItem("eating_custom_items_v2");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.all && parsed.all.length) {
        State.allCustomItems = sanitize(parsed.all);
        State.activeItems = parsed.active && parsed.active.length ? sanitize(parsed.active) : State.allCustomItems;
        saveCustomItems();
        return;
      }
    }
  } catch (e) {
    // 預設回復
  }
  State.allCustomItems = [...DEFAULT_ITEMS];
  State.activeItems = [...DEFAULT_ITEMS];
  saveCustomItems();
}

// ==========================================================================
// 11. Toast 浮動提示元件
// ==========================================================================
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 2600);
}

// ==========================================================================
// 12. 應用程式進入點與事件綁定 (Initialization)
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
  // 載入品項與歷史
  loadCustomItems();
  HistoryManager.load();

  // 初始化轉盤
  wheel = new RouletteWheel("wheelCanvas");
  window.addEventListener("resize", () => wheel.resize());

  // 綁定旋轉按鈕
  document.getElementById("centerSpinBtn").onclick = () => spinRoulette();

  // 綁定重新定位按鈕
  document.getElementById("reLocateBtn").onclick = () => initLocation();

  // 設定彈窗機制
  setupModals();

  // 自動啟動定位檢查
  initLocation();
});
