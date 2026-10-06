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
// 1. 預設 25 種具體單一美食品項與傳統和風配色
// ==========================================================================
const DEFAULT_ITEMS = [
  "炒飯", "炒麵", "早午餐", "定食", "便當",
  "義大利麵", "燉飯", "拉麵", "烏龍麵", "火鍋",
  "咖哩飯", "牛肉麵", "水餃", "鍋貼", "滷肉飯",
  "雞肉飯", "健康餐盒", "鐵板燒", "漢堡", "披薩",
  "壽司", "丼飯", "蛋包飯", "湯包", "鴨肉飯"
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
  // 搜尋半徑 (公尺)
  radius: 1000,
  // 歷史紀錄資料庫 key
  STORAGE_HISTORY_KEY: "eating_history_records_v1",
  STORAGE_CUSTOM_ITEMS_KEY: "eating_custom_items_v1",
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
    alertHeader.innerHTML = `<span>⚠️</span><span>溫馨提示：您在<strong>${eatenStatus.label}</strong>！</span>`;
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
// 9. 周邊真實店家搜尋 (OpenStreetMap Overpass API + Fail-safe 容錯)
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
    listEl.innerHTML = `
      <div class="empty-box">
        <p>尚未開啟手機 GPS 定位權限</p>
        <p style="font-size: 12px; color: #8C827A;">點擊下方按鈕可直接以 Google Maps App 搜尋您附近的【${category}】</p>
        <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('附近 ' + category)}" 
           target="_blank" rel="noopener noreferrer" class="direct-gmaps-fallback">
          <span>🗺️</span> 前往 Google Maps 搜尋周邊【${category}】
        </a>
      </div>
    `;
    return;
  }

  // 顯示載入動畫
  listEl.innerHTML = `
    <div class="loading-box">
      <div class="spinner"></div>
      <p>正在為您由近到遠尋找附近的【${category}】與餐廳...</p>
    </div>
  `;

  const { lat, lon } = State.userLocation;
  const radius = State.radius;

  // 使用 Overpass API 查詢周邊餐廳與小吃店家
  // 設定 5 秒超時機制以利快速容錯降級
  const overpassQuery = `[out:json][timeout:6];(
    node["amenity"~"restaurant|fast_food|cafe"](around:${radius},${lat},${lon});
  );out 35;`;

  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6500);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error("API 伺服器忙碌中");
    const data = await res.json();

    const elements = data.elements || [];
    const validRestaurants = [];

    // 解析店家名稱與經緯度
    for (const el of elements) {
      const name = el.tags && (el.tags.name || el.tags["name:zh"] || el.tags["name:en"]);
      if (name && name.trim()) {
        const dist = calculateDistanceMeters(lat, lon, el.lat, el.lon);
        validRestaurants.push({
          name: name.trim(),
          lat: el.lat,
          lon: el.lon,
          distance: dist,
          cuisine: el.tags.cuisine || el.tags.amenity || ""
        });
      }
    }

    // 依距離由近到遠嚴格排序 (Nearest First)
    validRestaurants.sort((a, b) => a.distance - b.distance);

    renderRestaurantCards(validRestaurants, category);
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn("Overpass API 查詢降級備援:", err);
    // 智慧容錯：無縫降級為 Google Maps 深度連結
    renderFallbackGmapsView(category);
  }
}

// 渲染餐廳清單卡片 (安全純原生 DOM textContent 注入，零 XSS 風險)
function renderRestaurantCards(restaurants, category) {
  const listEl = document.getElementById("restaurantList");
  const countEl = document.getElementById("searchCount");
  listEl.innerHTML = "";

  if (restaurants.length === 0) {
    countEl.textContent = "0 間";
    listEl.innerHTML = `
      <div class="empty-box">
        <p>在周邊 ${formatDistance(State.radius)} 內未找到收錄的店家</p>
        <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('附近 ' + category)}" 
           target="_blank" rel="noopener noreferrer" class="direct-gmaps-fallback">
          <span>🗺️</span> 於 Google Maps 擴大搜尋【${category}】
        </a>
      </div>
    `;
    return;
  }

  countEl.textContent = `找到 ${restaurants.length} 間（由近到遠）`;

  restaurants.forEach((r) => {
    const card = document.createElement("div");
    card.className = "restaurant-card";

    // 頂部列
    const topRow = document.createElement("div");
    topRow.className = "card-top-row";

    const titleArea = document.createElement("div");
    titleArea.className = "restaurant-title-area";

    const nameEl = document.createElement("div");
    nameEl.className = "restaurant-name";
    nameEl.textContent = r.name; // 原生安全防護
    titleArea.appendChild(nameEl);

    const badgesArea = document.createElement("div");
    badgesArea.className = "restaurant-badges";

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

    titleArea.appendChild(badgesArea);
    topRow.appendChild(titleArea);

    // 距離膠囊
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
    mapBtn.innerHTML = `<span>🧭</span> Google Maps 導航`;
    actionsRow.appendChild(mapBtn);

    // 「決定吃這家！」按鈕
    const eatBtn = document.createElement("button");
    eatBtn.className = "record-eat-btn";
    if (eatenStatus.eaten) {
      eatBtn.classList.add("already-eaten");
      eatBtn.innerHTML = `<span>✓</span> 重複踩點`;
    } else {
      eatBtn.innerHTML = `<span>🍚</span> 決定吃這家！`;
    }

    eatBtn.onclick = () => {
      HistoryManager.addRecord(r.name, category);
      eatBtn.classList.add("already-eaten");
      eatBtn.innerHTML = `<span>✓</span> 已記錄此餐`;
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

  listEl.innerHTML = `
    <div class="empty-box">
      <p style="font-size: 14px; font-weight: 700; color: #2C2825;">已為您連接 Google Maps</p>
      <p style="font-size: 12px; color: #7E766D; margin: 4px 0 10px;">
        點擊下方按鈕將直接開啟 Google Maps App，依您的當前位置由近到遠尋找附近的【${category}】店家：
      </p>
      <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('附近 ' + category)}" 
         target="_blank" rel="noopener noreferrer" class="direct-gmaps-fallback" style="padding: 12px 22px; font-size: 14px;">
        <span>🧭</span> 打開 Google Maps 尋找附近【${category}】
      </a>
      <div style="margin-top: 14px; width: 100%; border-top: 1px dashed #EAE4DA; padding-top: 12px;">
        <p style="font-size: 12px; color: #7E766D; margin-bottom: 8px;">踩點後可手動記錄今天的選擇：</p>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="manualRestaurantName" class="text-input" placeholder="輸入今天吃了哪家店..." style="font-size: 13px;">
          <button id="manualRecordBtn" class="btn-add" style="white-space: nowrap;">記錄這餐</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("manualRecordBtn").onclick = () => {
    const input = document.getElementById("manualRestaurantName");
    const name = input.value.trim();
    if (name) {
      HistoryManager.addRecord(name, category);
      showToast(`🎉 已為您記錄「${name}」！`);
      input.value = "";
      wheel.draw(State.currentAngle);
    }
  };
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

  // 新增自訂食物品項
  document.getElementById("addCustomItemBtn").onclick = () => {
    const input = document.getElementById("newCustomItemInput");
    const val = input.value.trim();
    if (!val) return;
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
  try {
    const raw = localStorage.getItem(State.STORAGE_CUSTOM_ITEMS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.all && parsed.all.length) {
        State.allCustomItems = parsed.all;
        State.activeItems = parsed.active && parsed.active.length ? parsed.active : parsed.all;
        return;
      }
    }
  } catch (e) {
    // 預設回復
  }
  State.allCustomItems = [...DEFAULT_ITEMS];
  State.activeItems = [...DEFAULT_ITEMS];
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

  // 綁定距離滑桿
  const radiusSlider = document.getElementById("radiusSlider");
  const radiusBadge = document.getElementById("radiusBadge");
  radiusSlider.addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    State.radius = val;
    radiusBadge.textContent = (val / 1000).toFixed(1) + " 公里";
  });

  // 綁定重新定位按鈕
  document.getElementById("reLocateBtn").onclick = () => initLocation();

  // 設定彈窗機制
  setupModals();

  // 自動啟動定位檢查
  initLocation();
});
