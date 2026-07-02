'use strict';

/* ============================================================
 * 단어장 앱 (Flashcard App)
 *
 * 단 하나의 단어장을 관리하는 심플한 낱말카드 앱.
 * 데이터는 localStorage에 저장. 나중에 클라우드 동기화 시
 * Storage 모듈만 교체하면 됨.
 *
 * 화면 구조 (4개):
 *  #1  홈 (랜딩)   - 앱 제목 + "단어장" / "단어추가" 버튼
 *  #2  단어 목록    - 전체 단어 리스트 + 학습하기 버튼
 *  #3  단어 추가    - 여러 줄 입력 (단어 — 뜻 형식)
 *  #4  학습 모드    - 낱말카드 플립 + 넘기기 + 셔플
 * ============================================================ */

// ============================================================
// 1. 유틸리티
// ============================================================

// HTML 본문에 넣을 텍스트의 특수문자 이스케이프 (XSS 방지)
function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

// HTML 속성값(value="...")에 넣을 때 사용. "가 포함되면 속성이 깨지므로 별도 처리
function escapeAttr(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// crypto.randomUUID()는 HTTPS에서만 동작하므로, HTTP 환경용 폴백 포함
function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Fisher-Yates 알고리즘으로 배열 섞기 (원본 변경 없이 새 배열 반환)
function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// 콤마로 구분된 정의를 배열로 파싱
// "이해하다, 인정하다,~라고 생각하다" → ["이해하다", "인정하다", "~라고 생각하다"]
function parseDefinitions(text) {
  return text.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// 낱말카드(학습 모드)용: 뜻이 여러 개면 번호 매겨서 세로 표시
function formatDefinitionCard(text) {
  const defs = parseDefinitions(text);
  if (defs.length <= 1) return escapeHtml(text);
  return '<div class="def-list">'
    + defs.map((d, i) =>
        `<div class="def-item"><span class="def-number">${i + 1}.</span> ${escapeHtml(d)}</div>`
      ).join('')
    + '</div>';
}

// 단어 목록용: 콤마+공백으로 정규화해서 인라인 표시
function formatDefinitionInline(text) {
  const defs = parseDefinitions(text);
  return defs.map(d => escapeHtml(d)).join(', ');
}

// "단어 — 뜻" 형식의 텍스트를 카드 배열로 변환
// 지원 구분자: " — " (em dash), " - " (hyphen), 또는 영어→한글 전환점
function parseBulkWords(text) {
  // 줄바꿈이 없어도 한글 끝 + 공백 + 영문 시작 지점에서 자동으로 줄을 나눔
  // 예: "사과 book — 책" → "사과\nbook — 책"
  text = text.replace(/([\uAC00-\uD7AF\u3131-\u318E)~])\s+([a-zA-Z])/g, '$1\n$2');

  return text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      // 1) em dash 구분자: "apple — 사과"
      let idx = line.indexOf(' — ');
      if (idx > 0) {
        return { term: line.slice(0, idx).trim(), definition: line.slice(idx + 3).trim() };
      }
      // 2) 공백 있는 hyphen 구분자: "apple - 사과"
      idx = line.indexOf(' - ');
      if (idx > 0) {
        return { term: line.slice(0, idx).trim(), definition: line.slice(idx + 3).trim() };
      }
      // 3) 공백 없는 hyphen/dash에서 영어→한글 전환: "apple-사과"
      const dashMatch = line.match(/^(.+?)[-—]([\uAC00-\uD7AF\u3131-\u318E~(].*)$/);
      if (dashMatch) {
        return { term: dashMatch[1].trim(), definition: dashMatch[2].trim() };
      }
      // 4) 구분자 없이 공백만: "apple 사과"
      const spaceMatch = line.match(/^(.+?)\s+([\uAC00-\uD7AF\u3131-\u318E~(].*)$/);
      if (spaceMatch) {
        return { term: spaceMatch[1].trim(), definition: spaceMatch[2].trim() };
      }
      return null;
    })
    .filter(Boolean);
}

// ============================================================
// 2. Storage - 단일 단어장 관리
//
// 카드 배열 하나만 저장. 세트 개념 없음.
// [{ id, term, definition, count }, ...]
// count: 이 단어가 추가된 횟수 (중복 추가 시 증가)
// ============================================================

const Storage = {
  KEY: 'flashcard_cards',

  // 모든 카드 가져오기
  getAll() {
    const data = localStorage.getItem(this.KEY);
    return data ? JSON.parse(data) : [];
  },

  // 새 카드들 추가 (중복 단어는 병합)
  addCards(newCards) {
    const cards = this.getAll();
    let mergedCount = 0;

    newCards.forEach(newCard => {
      // 소문자로 통일 저장
      newCard.term = newCard.term.trim().toLowerCase();

      const existing = cards.find(
        c => c.term.toLowerCase() === newCard.term
      );

      if (existing) {
        // 뜻 병합: 기존 뜻 + 새 뜻의 합집합
        const existingDefs = parseDefinitions(existing.definition);
        const newDefs = parseDefinitions(newCard.definition);
        newDefs.forEach(nd => {
          if (!existingDefs.includes(nd)) {
            existingDefs.push(nd);
          }
        });
        existing.definition = existingDefs.join(', ');
        existing.count = (existing.count || 1) + 1;
        mergedCount++;
      } else {
        // 새 단어 추가
        cards.push({
          id: generateId(),
          term: newCard.term,
          definition: newCard.definition,
          count: 1,
        });
      }
    });

    this._save(cards);
    return { cards, mergedCount };
  },

  // 특정 카드 수정
  updateCard(id, data) {
    const cards = this.getAll();
    const card = cards.find(c => c.id === id);
    if (!card) return null;
    Object.assign(card, data);
    this._save(cards);
    return card;
  },

  // 즐겨찾기 토글
  toggleFavorite(id) {
    const cards = this.getAll();
    const card = cards.find(c => c.id === id);
    if (!card) return null;
    card.favorite = !card.favorite;
    this._save(cards);
    return card;
  },

  // 특정 카드 삭제 → 휴지통으로 이동
  deleteCard(id) {
    const cards = this.getAll();
    const card = cards.find(c => c.id === id);
    if (card) {
      const trash = this.getTrash();
      card.deletedAt = Date.now();
      trash.unshift(card);
      this._saveTrash(trash);
    }
    this._save(cards.filter(c => c.id !== id));
    return cards.filter(c => c.id !== id);
  },

  // 휴지통
  TRASH_KEY: 'flashcard_trash',

  getTrash() {
    const data = localStorage.getItem(this.TRASH_KEY);
    return data ? JSON.parse(data) : [];
  },

  restoreCard(id) {
    const trash = this.getTrash();
    const card = trash.find(c => c.id === id);
    if (!card) return;
    delete card.deletedAt;
    const cards = this.getAll();
    cards.push(card);
    this._save(cards);
    this._saveTrash(trash.filter(c => c.id !== id));
  },

  permanentDelete(id) {
    this._saveTrash(this.getTrash().filter(c => c.id !== id));
  },

  emptyTrash() {
    this._saveTrash([]);
  },

  _saveTrash(trash) {
    localStorage.setItem(this.TRASH_KEY, JSON.stringify(trash));
  },

  // 전체 교체 (시드 데이터 로드 시 사용)
  replaceAll(newCards) {
    const cards = newCards.map(c => ({
      id: generateId(),
      term: c.term,
      definition: c.definition,
      count: 1,
      favorite: false,
    }));
    this._save(cards);
    return cards;
  },

  // 중복 단어 제거 (같은 term이면 뜻 병합 후 하나만 유지)
  dedup() {
    const cards = this.getAll();
    const map = new Map();
    cards.forEach(c => {
      const key = c.term.toLowerCase().trim();
      const existing = map.get(key);
      if (existing) {
        // 뜻 병합
        const eDefs = parseDefinitions(existing.definition);
        const nDefs = parseDefinitions(c.definition);
        nDefs.forEach(d => { if (!eDefs.includes(d)) eDefs.push(d); });
        existing.definition = eDefs.join(', ');
        existing.count = Math.max(existing.count || 1, c.count || 1);
        if (c.favorite) existing.favorite = true;
        if (c.updatedAt > (existing.updatedAt || 0)) existing.updatedAt = c.updatedAt;
      } else {
        map.set(key, { ...c });
      }
    });
    const deduped = Array.from(map.values());
    const removed = cards.length - deduped.length;
    if (removed > 0) this._save(deduped);
    return removed;
  },

  _save(cards) {
    localStorage.setItem(this.KEY, JSON.stringify(cards));
  },
};

// ============================================================
// 2-1. Firebase 동기화
//
// Google 로그인 → Firestore에 단어 데이터 저장/동기화
// 오프라인에서는 localStorage만 사용, 온라인 시 자동 동기화
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyBmAkRDbNgE1VZ8Zj2vizklM4imMTbECKw",
  authDomain: "chaewon-word.firebaseapp.com",
  projectId: "chaewon-word",
  storageBucket: "chaewon-word.firebasestorage.app",
  messagingSenderId: "574276438801",
  appId: "1:574276438801:web:0caf9da02a48caf1219ab0",
};

// Firebase 초기화 (SDK가 로드된 경우에만)
let fbAuth = null;
let fbDb = null;

if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
  fbAuth = firebase.auth();
  fbDb = firebase.firestore();
  // 오프라인 지속성 활성화
  fbDb.enablePersistence().catch(() => {});
}

const Sync = {
  // 현재 로그인된 사용자 ID
  getUserId() {
    return fbAuth && fbAuth.currentUser ? fbAuth.currentUser.uid : null;
  },

  // 로그인 상태
  isSignedIn() {
    return !!this.getUserId();
  },

  // Google 로그인 (signInWithPopup - 반드시 사용자 클릭 안에서 호출)
  signIn() {
    if (!fbAuth) return;
    const provider = new firebase.auth.GoogleAuthProvider();
    fbAuth.signInWithPopup(provider)
      .then(() => this.syncFromCloud())
      .then(() => renderHome())
      .catch(err => {
        // 팝업 차단 시 안내
        alert('팝업이 차단되었어요. Safari 설정 → 팝업 차단 해제 후 다시 시도해주세요.');
      });
  },

  // 로그아웃
  async signOut() {
    if (!fbAuth) return;
    await fbAuth.signOut();
  },

  // localStorage → Firestore 업로드 (개별 카드 updatedAt 기준 병합)
  async syncToCloud() {
    const uid = this.getUserId();
    if (!uid || !fbDb) return;

    try {
      const cards = Storage.getAll();
      const trash = Storage.getTrash();
      await fbDb.collection('users').doc(uid).set({
        cards: JSON.stringify(cards),
        trash: JSON.stringify(trash),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      localStorage.setItem('lastSyncAt', Date.now().toString());
    } catch (err) {
      console.error('동기화 업로드 실패:', err);
    }
  },

  // Firestore → localStorage 다운로드 + 병합
  async syncFromCloud() {
    const uid = this.getUserId();
    if (!uid || !fbDb) return;

    try {
      const doc = await fbDb.collection('users').doc(uid).get();
      if (!doc.exists) {
        // 클라우드에 데이터 없음 → 현재 로컬 데이터 업로드
        await this.syncToCloud();
        return;
      }

      const cloudData = doc.data();
      const cloudCards = JSON.parse(cloudData.cards || '[]');
      const cloudTrash = JSON.parse(cloudData.trash || '[]');
      const localCards = Storage.getAll();
      const localTrash = Storage.getTrash();

      // 카드 병합: ID 기준, updatedAt이 더 최신인 쪽 우선
      const merged = this._mergeCards(localCards, cloudCards);
      const mergedTrash = this._mergeCards(localTrash, cloudTrash);

      Storage._save(merged);
      Storage._saveTrash(mergedTrash);
      localStorage.setItem('lastSyncAt', Date.now().toString());

      // 병합 후 중복 제거
      Storage.dedup();
      // 정리된 결과를 다시 클라우드에 업로드
      await this.syncToCloud();
    } catch (err) {
      console.error('동기화 다운로드 실패:', err);
    }
  },

  // 두 카드 배열 병합 (term 기준, 뜻 합집합, updatedAt 최신 우선)
  _mergeCards(localCards, cloudCards) {
    const map = new Map();

    function addCard(c) {
      c.updatedAt = c.updatedAt || 0;
      const key = c.term.toLowerCase().trim();
      const existing = map.get(key);
      if (existing) {
        // 뜻 합집합
        const eDefs = parseDefinitions(existing.definition);
        const nDefs = parseDefinitions(c.definition);
        nDefs.forEach(d => { if (!eDefs.includes(d)) eDefs.push(d); });
        existing.definition = eDefs.join(', ');
        if (c.favorite) existing.favorite = true;
        existing.count = Math.max(existing.count || 1, c.count || 1);
        if (c.updatedAt > existing.updatedAt) existing.updatedAt = c.updatedAt;
      } else {
        map.set(key, { ...c });
      }
    }

    localCards.forEach(addCard);
    cloudCards.forEach(addCard);
    return Array.from(map.values());
  },

  // 동기화 상태 텍스트
  getStatusText() {
    if (!fbAuth) return '';
    if (!this.isSignedIn()) return '로그인하면 기기 간 동기화';
    const lastSync = localStorage.getItem('lastSyncAt');
    if (lastSync) {
      const ago = Math.round((Date.now() - parseInt(lastSync)) / 60000);
      return ago < 1 ? '방금 동기화됨' : `${ago}분 전 동기화`;
    }
    return '동기화 대기 중';
  },
};

// Storage 함수에 updatedAt 자동 추가 + 변경 시 자동 동기화
const originalAddCards = Storage.addCards.bind(Storage);
Storage.addCards = function(newCards) {
  const result = originalAddCards(newCards);
  // 각 카드에 updatedAt 추가
  const cards = this.getAll();
  cards.forEach(c => { if (!c.updatedAt) c.updatedAt = Date.now(); });
  this._save(cards);
  // 비동기 동기화 (UI 블로킹 없이)
  if (Sync.isSignedIn()) Sync.syncToCloud();
  return result;
};

const originalUpdateCard = Storage.updateCard.bind(Storage);
Storage.updateCard = function(id, data) {
  data.updatedAt = Date.now();
  const result = originalUpdateCard(id, data);
  if (Sync.isSignedIn()) Sync.syncToCloud();
  return result;
};

const originalToggleFav = Storage.toggleFavorite.bind(Storage);
Storage.toggleFavorite = function(id) {
  const result = originalToggleFav(id);
  if (result) {
    const cards = this.getAll();
    const card = cards.find(c => c.id === id);
    if (card) { card.updatedAt = Date.now(); this._save(cards); }
  }
  if (Sync.isSignedIn()) Sync.syncToCloud();
  return result;
};

const originalDeleteCard = Storage.deleteCard.bind(Storage);
Storage.deleteCard = function(id) {
  const result = originalDeleteCard(id);
  if (Sync.isSignedIn()) Sync.syncToCloud();
  return result;
};

// ============================================================
// 3. Router - 해시(#) 기반 페이지 전환
//
// #/            → 홈 (랜딩)
// #/alphabet    → 알파벳 선택 그리드
// #/words/A     → A로 시작하는 단어 목록
// #/add         → 단어 추가
// #/study       → 전체 학습
// #/study/A     → A 단어만 학습
// ============================================================

const $app = document.getElementById('app');
let cleanupFn = null;

function setCleanup(fn) {
  if (cleanupFn) cleanupFn();
  cleanupFn = fn || null;
}

const Router = {
  init() {
    window.addEventListener('hashchange', () => this.handle());
    this.handle();
  },

  handle() {
    const hash = location.hash.slice(1) || '/';
    setCleanup(null);

    if (hash === '/') renderHome();
    else if (hash === '/alphabet') renderAlphabet();
    else if (hash === '/search') renderSearch();
    else if (hash === '/trash') renderTrash();
    else if (hash.startsWith('/words/')) renderWords(hash.split('/')[2]);
    else if (hash === '/add') renderAdd();
    else if (hash.startsWith('/study/')) renderStudy(hash.split('/')[2]);
    else if (hash === '/study') renderStudy();
    else location.hash = '#/';
  },

  go(path) {
    location.hash = '#' + path;
  },
};

// ============================================================
// 4. Views
// ============================================================

// ---- 홈 (앱 메인 화면) ----

function renderHome() {
  const cardCount = Storage.getAll().length;
  const hasWords = cardCount > 0;

  const syncStatus = Sync.getStatusText();
  const signedIn = Sync.isSignedIn();
  const userName = fbAuth && fbAuth.currentUser ? fbAuth.currentUser.displayName : '';

  $app.innerHTML = `
    <header class="home-header">
      <h1 class="home-title">단어장</h1>
      ${hasWords ? `<p class="home-sub">${cardCount}개 단어</p>` : ''}
      <div class="sync-bar">
        ${signedIn
          ? `<span class="sync-status">${escapeHtml(userName)} · ${syncStatus}</span>
             <button class="sync-btn" data-action="sync">동기화</button>
             <button class="sync-btn" data-action="signout">로그아웃</button>`
          : `<button class="sync-btn sync-btn-login" data-action="signin">Google 로그인으로 기기 동기화</button>`
        }
      </div>
    </header>
    <div class="home-cards">
      ${hasWords ? `
        <button class="home-card" data-action="words">
          <span class="home-card-icon home-card-icon-light">A-Z</span>
          <div>
            <span class="home-card-title">단어장</span>
            <span class="home-card-desc">알파벳별 단어 보기</span>
          </div>
        </button>
      ` : ''}
      <button class="home-card home-card-primary" data-action="add">
        <span class="home-card-icon">+</span>
        <div>
          <span class="home-card-title">${hasWords ? '단어추가' : '첫 단어 추가하기'}</span>
          <span class="home-card-desc home-card-desc-light">하나씩 또는 대량으로 추가</span>
        </div>
      </button>
      ${hasWords ? `
        <button class="home-card" data-action="study">
          <span class="home-card-icon home-card-icon-light">Aa</span>
          <div>
            <span class="home-card-title">낱말카드</span>
            <span class="home-card-desc">전체 단어 학습</span>
          </div>
        </button>
      ` : `
        <p class="home-empty">아직 단어가 없어요.<br>위 버튼을 눌러 단어를 추가해보세요!</p>
      `}
    </div>
  `;

  const handler = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'words') Router.go('/alphabet');
    else if (el.dataset.action === 'add') Router.go('/add');
    else if (el.dataset.action === 'study') Router.go('/study');
    else if (el.dataset.action === 'signin') {
      Sync.signIn();
    }
    else if (el.dataset.action === 'sync') {
      const btn = el;
      btn.textContent = '동기화 중...';
      Sync.syncFromCloud().then(() => renderHome());
    }
    else if (el.dataset.action === 'signout') {
      Sync.signOut().then(() => renderHome());
    }
  };

  $app.addEventListener('click', handler);
  setCleanup(() => $app.removeEventListener('click', handler));
}

// ---- 알파벳 선택 그리드 (#3-1) ----
// 알파벳 A~Z를 4열 그리드로 표시, 각 버튼에 단어 수 표시

function renderAlphabet() {
  const cards = Storage.getAll();

  // 알파벳별 단어 수 + 즐겨찾기 수 세기
  const counts = {};
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(l => { counts[l] = 0; });
  let favCount = 0;
  cards.forEach(c => {
    const initial = c.term.charAt(0).toUpperCase();
    if (counts[initial] !== undefined) counts[initial]++;
    if (c.favorite) favCount++;
  });

  $app.innerHTML = `
    <header class="header">
      <button class="btn-back" data-action="home" type="button">\u2190</button>
      <h1>단어장</h1>
      <span class="header-count">${cards.length}개</span>
      <button class="btn-search" data-action="trash" type="button">\u{1F5D1}</button>
      <button class="btn-search" data-action="search" type="button">\u{1F50D}</button>
    </header>
    <div class="alphabet-page">
      <div class="alphabet-grid">
        <button class="alphabet-btn alphabet-btn-fav ${favCount === 0 ? 'alphabet-btn-empty' : ''}"
          data-action="select-letter" data-letter="FAV"
          ${favCount === 0 ? 'disabled' : ''}>
          <span class="alphabet-letter">\u2605</span>
          <span class="alphabet-count">${favCount}</span>
        </button>
        ${Object.entries(counts).map(([letter, count]) => `
          <button class="alphabet-btn ${count === 0 ? 'alphabet-btn-empty' : ''}"
            data-action="select-letter" data-letter="${letter}"
            ${count === 0 ? 'disabled' : ''}>
            <span class="alphabet-letter">${letter}</span>
            <span class="alphabet-count">${count}</span>
          </button>
        `).join('')}
        ${'<div class="alphabet-spacer"></div>'.repeat(3)}
      </div>
    </div>
  `;

  const handler = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    if (el.dataset.action === 'home') Router.go('/');
    else if (el.dataset.action === 'search') Router.go('/search');
    else if (el.dataset.action === 'trash') Router.go('/trash');
    else if (el.dataset.action === 'select-letter') Router.go('/words/' + el.dataset.letter);
  };

  $app.addEventListener('click', handler);
  setCleanup(() => $app.removeEventListener('click', handler));
}

// ---- 검색 ----

function renderSearch() {
  let allCards = Storage.getAll();

  $app.innerHTML = `
    <header class="header">
      <button class="btn-back" data-action="back" type="button">\u2190</button>
      <input type="text" id="search-input" class="search-input"
        placeholder="영어 또는 한국어로 검색" autofocus />
    </header>
    <div class="search-page">
      <div id="search-results" class="word-list"></div>
    </div>
  `;

  const input = document.getElementById('search-input');
  const resultsEl = document.getElementById('search-results');

  // 입력할 때마다 실시간 검색
  function doSearch() {
    const query = input.value.trim().toLowerCase();
    if (!query) {
      resultsEl.innerHTML = '<p class="search-hint">단어 또는 뜻을 입력하세요</p>';
      return;
    }

    const matches = allCards.filter(c =>
      c.term.toLowerCase().includes(query) ||
      c.definition.toLowerCase().includes(query)
    );

    if (matches.length === 0) {
      resultsEl.innerHTML = '<p class="search-hint">검색 결과가 없어요</p>';
      return;
    }

    resultsEl.innerHTML = `<p class="words-count">${matches.length}개 결과</p>`
      + matches.map(c => `
        <div class="word-item" data-id="${c.id}">
          <button class="btn-fav ${c.favorite ? 'btn-fav-on' : ''}"
            data-action="toggle-fav" data-id="${c.id}"
            type="button">${c.favorite ? '\u2605' : '\u2606'}</button>
          <div class="word-body" data-action="dbl-word" data-id="${c.id}">
            <span class="word-term">${highlightMatch(escapeHtml(c.term), query)}${c.count > 1 ? ` <span class="word-hit">\u00D7${c.count}</span>` : ''}</span>
            <span class="word-definition">${highlightMatch(formatDefinitionInline(c.definition), query)}</span>
          </div>
          <button class="btn-word-more" data-action="edit-word" data-id="${c.id}"
            type="button">\u22EF</button>
        </div>
      `).join('');
  }

  input.addEventListener('input', doSearch);

  let searchLastTapId = null;
  let searchLastTapTime = 0;

  const handler = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'back') Router.go('/alphabet');
    else if (el.dataset.action === 'toggle-fav') {
      Storage.toggleFavorite(el.dataset.id);
      allCards = Storage.getAll();
      doSearch();
    } else if (el.dataset.action === 'edit-word') {
      showEditModal(el.dataset.id, null);
    } else if (el.dataset.action === 'dbl-word') {
      const id = el.dataset.id;
      const now = Date.now();
      if (searchLastTapId === id && now - searchLastTapTime < 400) {
        Storage.toggleFavorite(id);
        allCards = Storage.getAll();
        doSearch();
        searchLastTapId = null;
        return;
      }
      searchLastTapId = id;
      searchLastTapTime = now;
    }
  };

  $app.addEventListener('click', handler);
  setCleanup(() => {
    $app.removeEventListener('click', handler);
  });
}

// 검색어 하이라이트: 매칭된 부분을 <mark>로 감싸서 강조
function highlightMatch(html, query) {
  if (!query) return html;
  // 이미 이스케이프된 HTML에서 텍스트 부분만 하이라이트
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return html.replace(regex, '<mark>$1</mark>');
}

// ---- 휴지통 ----

function renderTrash() {
  const trash = Storage.getTrash();

  $app.innerHTML = `
    <header class="header">
      <button class="btn-back" data-action="back" type="button">\u2190</button>
      <h1>휴지통</h1>
      <span class="header-count">${trash.length}개</span>
    </header>
    <div class="words-page">
      ${trash.length > 0 ? `
        <div class="words-actions">
          <button class="btn-study" data-action="empty-trash"
            style="background:var(--danger)">전체 삭제</button>
        </div>
      ` : ''}
      <div class="word-list">
        ${trash.length === 0
          ? '<p class="empty">휴지통이 비어있어요.</p>'
          : trash.map(c => `
            <div class="word-item trash-item" data-id="${c.id}">
              <div class="word-body">
                <span class="word-term">${escapeHtml(c.term)}</span>
                <span class="word-definition">${formatDefinitionInline(c.definition)}</span>
              </div>
              <button class="btn-restore" data-action="restore" data-id="${c.id}"
                type="button">복원</button>
              <button class="btn-word-more" data-action="perm-delete" data-id="${c.id}"
                type="button">\u00D7</button>
            </div>
          `).join('')}
      </div>
    </div>
  `;

  const handler = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;

    switch (el.dataset.action) {
      case 'back': Router.go('/alphabet'); break;
      case 'restore':
        Storage.restoreCard(el.dataset.id);
        renderTrash();
        break;
      case 'perm-delete':
        Storage.permanentDelete(el.dataset.id);
        renderTrash();
        break;
      case 'empty-trash':
        if (el.textContent === '전체 삭제') {
          el.textContent = '정말 전체 삭제?';
          setTimeout(() => { el.textContent = '전체 삭제'; }, 3000);
        } else {
          Storage.emptyTrash();
          renderTrash();
        }
        break;
    }
  };

  $app.addEventListener('click', handler);
  setCleanup(() => $app.removeEventListener('click', handler));
}

// ---- 단어 목록 (알파벳별) ----

function renderWords(letter) {
  const allCards = Storage.getAll();
  const isFav = letter && letter.toUpperCase() === 'FAV';
  const cards = isFav
    ? allCards.filter(c => c.favorite)
    : letter
      ? allCards.filter(c => c.term.charAt(0).toUpperCase() === letter.toUpperCase())
      : allCards;
  const displayLetter = isFav ? '\u2605' : (letter ? letter.toUpperCase() : '');

  $app.innerHTML = `
    <header class="header">
      <button class="btn-back" data-action="back" type="button">\u2190</button>
      <h1>${displayLetter}</h1>
      <span class="header-count">${cards.length}개</span>
      <button class="btn-search" data-action="search" type="button">\u{1F50D}</button>
    </header>
    <div class="words-page">
      <div class="words-actions">
        <button class="btn-study" data-action="study"
          ${cards.length === 0 ? 'disabled' : ''}>
          낱말카드
        </button>
        <button class="btn-add-small" data-action="add">+ 추가</button>
        <button class="btn-hide-def" data-action="toggle-hide" id="btn-hide-def">뜻 숨기기</button>
      </div>
      <p class="words-hint">두 번 터치: 별표 | \u22EF 버튼: 수정/삭제</p>
      <div class="word-list">
        ${cards.length === 0
          ? '<p class="empty">이 알파벳에 단어가 없어요.</p>'
          : cards.map(c => `
            <div class="word-item" data-id="${c.id}">
              <button class="btn-fav ${c.favorite ? 'btn-fav-on' : ''}"
                data-action="toggle-fav" data-id="${c.id}"
                type="button">${c.favorite ? '\u2605' : '\u2606'}</button>
              <div class="word-body" data-action="dbl-word" data-id="${c.id}">
                <span class="word-term">${escapeHtml(c.term)}${c.count > 1 ? ` <span class="word-hit">\u00D7${c.count}</span>` : ''}</span>
                <span class="word-definition">${formatDefinitionInline(c.definition)}</span>
              </div>
              <button class="btn-word-more" data-action="edit-word" data-id="${c.id}"
                type="button">\u22EF</button>
            </div>
          `).join('')}
      </div>
    </div>
  `;

  // 더블탭 → 별표
  let lastTapId = null;
  let lastTapTime = 0;

  const handler = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;

    switch (el.dataset.action) {
      case 'back': Router.go('/alphabet'); break;
      case 'search': Router.go('/search'); break;
      case 'study': Router.go('/study/' + (isFav ? 'FAV' : displayLetter)); break;
      case 'add': Router.go('/add'); break;
      case 'toggle-hide': {
        const wordList = document.querySelector('.word-list');
        const btn = document.getElementById('btn-hide-def');
        wordList.classList.toggle('hide-defs');
        const hidden = wordList.classList.contains('hide-defs');
        btn.textContent = hidden ? '뜻 보기' : '뜻 숨기기';
        btn.classList.toggle('btn-hide-active', hidden);
        break;
      }
      case 'toggle-fav':
        e.stopPropagation();
        Storage.toggleFavorite(el.dataset.id);
        renderWords(letter);
        break;
      case 'dbl-word': {
        // 더블탭 → 별표 토글
        const id = el.dataset.id;
        const now = Date.now();
        if (lastTapId === id && now - lastTapTime < 400) {
          Storage.toggleFavorite(id);
          renderWords(letter);
          lastTapId = null;
          return;
        }
        lastTapId = id;
        lastTapTime = now;
        break;
      }
      case 'edit-word':
        // ... 버튼 → 바로 수정 모달
        showEditModal(el.dataset.id, letter);
        break;
    }
  };

  // 숨긴 뜻 개별 탭 → 잠깐 보이기
  function onDefClick(e) {
    const def = e.target.closest('.word-definition');
    if (def && def.closest('.hide-defs')) {
      def.classList.toggle('def-revealed');
    }
  }

  $app.addEventListener('click', onDefClick);
  $app.addEventListener('click', handler);
  setCleanup(() => {
    $app.removeEventListener('click', handler);
    $app.removeEventListener('click', onDefClick);
  });
}

// 단어 수정 모달
function showEditModal(id, letter) {
  // 이미 모달이 열려있으면 무시
  if (document.querySelector('.modal-overlay')) return;
  const card = Storage.getAll().find(c => c.id === id);
  if (!card) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-edit">
      <h3>단어 수정</h3>
      <div class="modal-field">
        <label>단어</label>
        <input type="text" id="edit-term" value="${escapeAttr(card.term)}" />
      </div>
      <div class="modal-field">
        <label>뜻</label>
        <input type="text" id="edit-def" value="${escapeAttr(card.definition)}" />
      </div>
      <div class="modal-row">
        <button class="btn-fav-modal ${card.favorite ? 'btn-fav-on' : ''}"
          id="edit-fav">${card.favorite ? '\u2605 즐겨찾기' : '\u2606 즐겨찾기'}</button>
        <button class="btn-modal-delete" id="edit-delete">삭제</button>
      </div>
      <div class="modal-actions">
        <button class="btn-modal-cancel" id="edit-cancel">취소</button>
        <button class="btn-modal-save" id="edit-save">저장</button>
      </div>
    </div>
  `;

  // 입력칸 탭 시 커서를 맨 뒤로
  overlay.querySelectorAll('input[type="text"]').forEach(input => {
    input.addEventListener('focus', () => {
      const len = input.value.length;
      setTimeout(() => input.setSelectionRange(len, len), 0);
    });
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelector('#edit-cancel').addEventListener('click', () => overlay.remove());

  // 저장
  overlay.querySelector('#edit-save').addEventListener('click', () => {
    const term = overlay.querySelector('#edit-term').value.trim();
    const def = overlay.querySelector('#edit-def').value.trim();
    if (!term || !def) return;
    Storage.updateCard(id, { term, definition: def });
    overlay.remove();
    renderWords(letter);
  });

  // 즐겨찾기 토글
  overlay.querySelector('#edit-fav').addEventListener('click', () => {
    const updated = Storage.toggleFavorite(id);
    const btn = overlay.querySelector('#edit-fav');
    btn.classList.toggle('btn-fav-on', updated.favorite);
    btn.textContent = updated.favorite ? '\u2605 즐겨찾기' : '\u2606 즐겨찾기';
  });

  // 삭제: 버튼을 "정말 삭제?" 로 변경 → 다시 탭하면 삭제
  const deleteBtn = overlay.querySelector('#edit-delete');
  let deleteConfirm = false;
  deleteBtn.addEventListener('click', () => {
    if (deleteConfirm) {
      Storage.deleteCard(id);
      // "삭제되었습니다" 잠깐 표시 후 닫기
      overlay.querySelector('.modal-edit').innerHTML =
        '<p style="text-align:center;padding:32px;font-size:16px;color:var(--text-secondary)">삭제되었습니다</p>';
      setTimeout(() => {
        overlay.remove();
        if (letter) renderWords(letter);
      }, 600);
    } else {
      deleteConfirm = true;
      deleteBtn.textContent = '정말 삭제?';
      deleteBtn.style.background = 'var(--danger)';
      deleteBtn.style.color = 'white';
      // 3초 후 원래대로
      setTimeout(() => {
        deleteConfirm = false;
        deleteBtn.textContent = '삭제';
        deleteBtn.style.background = '';
        deleteBtn.style.color = '';
      }, 3000);
    }
  });

  document.body.appendChild(overlay);
}

// ---- 단어 추가 ----

function renderAdd() {
  $app.innerHTML = `
    <header class="header">
      <button class="btn-back" data-action="back" type="button">\u2190</button>
      <h1>단어추가</h1>
    </header>
    <div class="add-page">
      <div class="add-tabs">
        <button class="add-tab add-tab-active" data-action="tab-single">하나씩</button>
        <button class="add-tab" data-action="tab-bulk">대량 입력</button>
      </div>
      <div id="add-content"></div>
    </div>
  `;

  showSingleInput();

  const handler = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'back') Router.go('/');
    else if (el.dataset.action === 'save') saveNewWords();
    else if (el.dataset.action === 'tab-single') {
      setActiveTab(0);
      showSingleInput();
    } else if (el.dataset.action === 'tab-bulk') {
      setActiveTab(1);
      showBulkInput();
    }
  };

  function setActiveTab(idx) {
    document.querySelectorAll('.add-tab').forEach((t, i) => {
      t.classList.toggle('add-tab-active', i === idx);
    });
  }

  $app.addEventListener('click', handler);
  setCleanup(() => $app.removeEventListener('click', handler));
}

// 하나씩 입력 모드
function showSingleInput() {
  const content = document.getElementById('add-content');
  content.innerHTML = `
    <div class="single-input">
      <div class="single-row" id="term-row">
        <input type="text" id="single-term" class="single-field"
          placeholder="영어 단어" autocomplete="off" />
        <button type="button" class="single-btn" id="btn-next-step">다음</button>
      </div>
      <p class="input-warn" id="term-warn"></p>
      <div class="single-row" id="def-row" style="display:none">
        <input type="text" id="single-def" class="single-field"
          placeholder="뜻 (콤마로 여러 뜻 구분)" autocomplete="off" />
        <button type="button" class="single-btn single-btn-primary" id="btn-add-word">추가</button>
      </div>
    </div>
    <div id="single-added" class="single-added"></div>
  `;

  const termInput = document.getElementById('single-term');
  const defInput = document.getElementById('single-def');
  const termWarn = document.getElementById('term-warn');
  const termRow = document.getElementById('term-row');
  const defRow = document.getElementById('def-row');
  const addedList = document.getElementById('single-added');
  let sessionWords = [];

  // 한글 감지 패턴
  const hasKorean = (text) => /[\uAC00-\uD7AF\u3131-\u318E]/.test(text);

  termInput.focus();

  // 영어 입력칸에 한글이 들어가면 경고
  termInput.addEventListener('input', () => {
    if (hasKorean(termInput.value)) {
      termInput.classList.add('input-error');
      termWarn.textContent = '영어 단어를 입력하세요 (한글이 감지됨)';
    } else {
      termInput.classList.remove('input-error');
      termWarn.textContent = '';
    }
  });

  // 영어 → 뜻 입력으로 전환
  function goToDefInput() {
    const val = termInput.value.trim();
    if (!val) return;
    if (hasKorean(val)) {
      termInput.classList.add('input-error');
      termWarn.textContent = '영어 단어를 입력하세요 (한글이 감지됨)';
      return;
    }
    termRow.style.display = 'none';
    termWarn.style.display = 'none';
    defRow.style.display = '';
    defInput.focus();
  }

  termInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); goToDefInput(); }
  });
  document.getElementById('btn-next-step').addEventListener('click', goToDefInput);

  // 단어 추가 실행
  function addWord() {
    const term = termInput.value.trim();
    const def = defInput.value.trim();
    if (!term || !def) return;

    const result = Storage.addCards([{ term, definition: def }]);
    sessionWords.push({ term, definition: def, merged: result.mergedCount > 0 });

    addedList.innerHTML = `<p class="single-added-count">${sessionWords.length}개 추가됨</p>`
      + sessionWords.map(w =>
        `<div class="single-added-item${w.merged ? ' merged' : ''}">${escapeHtml(w.term)} — ${escapeHtml(w.definition)}</div>`
      ).join('');

    // 초기화: 다시 영어 입력
    termInput.value = '';
    defInput.value = '';
    defRow.style.display = 'none';
    termRow.style.display = '';
    termWarn.style.display = '';
    termWarn.textContent = '';
    termInput.classList.remove('input-error');
    termInput.focus();
    addedList.scrollTop = addedList.scrollHeight;
  }

  defInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addWord(); }
    else if (e.key === 'Escape') {
      defRow.style.display = 'none';
      termRow.style.display = '';
      termInput.focus();
    }
  });
  document.getElementById('btn-add-word').addEventListener('click', addWord);
}

// 대량 입력 모드
function showBulkInput() {
  const content = document.getElementById('add-content');
  content.innerHTML = `
    <div class="add-help">
      <strong>단어 — 뜻</strong> 형식으로 입력하거나 PDF를 업로드하세요.
    </div>
    <div class="bulk-actions">
      <div class="add-status" id="add-status"></div>
      <label class="btn-pdf btn-pdf-disabled" id="btn-pdf" title="추후 개발 예정">
        <span id="pdf-label-text">PDF (준비 중)</span>
      </label>
      <button class="btn-save" data-action="save" type="button">저장</button>
    </div>
    <textarea id="bulk-input" class="bulk-input" rows="8"
      placeholder="apple — 사과&#10;book — 책&#10;accommodate — 수용하다, 숙박시키다"></textarea>
    <div id="bulk-preview" class="bulk-preview"></div>
  `;

  document.getElementById('bulk-input').addEventListener('input', updateAddStatus);

  // PDF 업로드 처리
  document.getElementById('pdf-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const status = document.getElementById('add-status');
    const btnPdf = document.getElementById('btn-pdf');
    status.innerHTML = '<span class="status-ok">PDF 읽는 중...</span>';
    document.getElementById('pdf-label-text').textContent = '읽는 중...';

    try {
      const text = await extractPdfText(file);
      document.getElementById('pdf-label-text').textContent = 'PDF';

      if (!text.trim()) {
        status.innerHTML = '<span class="status-warn">PDF에서 텍스트를 찾을 수 없어요 (스캔/손글씨 PDF는 지원 안 됨)</span>';
        return;
      }

      const textarea = document.getElementById('bulk-input');
      const newValue = textarea.value
        ? textarea.value + '\n' + text
        : text;
      textarea.value = newValue;
      textarea.dispatchEvent(new Event('input'));
      textarea.scrollTop = 0;
      textarea.focus();
      updateAddStatus();

      const parsed = parseBulkWords(text);
      if (parsed.length > 0) {
        status.innerHTML = `<span class="status-ok">PDF에서 ${parsed.length}개 단어 추출됨</span>`;
      } else {
        // 파싱은 안 되지만 텍스트는 있는 경우 → 원본 보여주기
        status.innerHTML = `<span class="status-warn">텍스트는 추출됐지만 단어-뜻 쌍을 인식하지 못했어요. 텍스트를 직접 확인/수정해주세요.</span>`;
      }
    } catch (err) {
      document.getElementById('pdf-label-text').textContent = 'PDF';
      status.innerHTML = '<span class="status-warn">PDF 읽기 실패: ' + escapeHtml(String(err.message || err)) + '</span>';
    }
  });

  document.getElementById('bulk-input').focus();
}

// PDF에서 텍스트 추출
async function extractPdfText(file) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF 라이브러리가 로드되지 않았어요.');
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    // 텍스트 아이템을 Y좌표 기준으로 그룹핑 (같은 줄 판별)
    let lastY = null;
    let line = '';
    content.items.forEach(item => {
      if (item.str.trim() === '') return;
      const y = Math.round(item.transform[5]); // Y좌표
      if (lastY !== null && Math.abs(y - lastY) > 5) {
        // Y좌표가 다르면 새 줄
        fullText += line.trim() + '\n';
        line = '';
      }
      line += item.str + ' ';
      lastY = y;
    });
    if (line.trim()) fullText += line.trim() + '\n';
  }

  return fullText.trim();
}

function updateAddStatus() {
  const text = document.getElementById('bulk-input').value;
  const parsed = parseBulkWords(text);
  const status = document.getElementById('add-status');
  const lineCount = text.split('\n').filter(l => l.trim().length > 0).length;
  const failCount = lineCount - parsed.length;

  const preview = document.getElementById('bulk-preview');

  if (text.trim().length === 0) {
    status.textContent = '';
    if (preview) preview.innerHTML = '';
  } else {
    if (failCount > 0) {
      status.innerHTML = `<span class="status-ok">${parsed.length}개 인식</span> · <span class="status-warn">${failCount}개 실패</span>`;
    } else {
      status.innerHTML = `<span class="status-ok">${parsed.length}개 인식</span>`;
    }
    // 파싱 결과 미리보기
    if (preview) {
      preview.innerHTML = parsed.map(c =>
        `<div class="bulk-preview-item">
          <span class="bulk-preview-term">${escapeHtml(c.term)}</span>
          <span class="bulk-preview-def">${escapeHtml(c.definition)}</span>
        </div>`
      ).join('');
    }
  }
}

function saveNewWords() {
  const textarea = document.getElementById('bulk-input');
  const text = textarea.value.trim();

  if (!text) {
    textarea.focus();
    return;
  }

  const cards = parseBulkWords(text);
  if (cards.length === 0) {
    const status = document.getElementById('add-status');
    status.innerHTML = '<span class="status-warn">인식된 단어가 없어요. 형식을 확인해주세요.</span>';
    textarea.focus();
    return;
  }

  const result = Storage.addCards(cards);
  const newCount = cards.length - result.mergedCount;

  // 결과를 잠깐 보여주고 이동
  const status = document.getElementById('add-status');
  if (result.mergedCount > 0) {
    status.innerHTML = `<span class="status-ok">${newCount}개 새 단어 추가, ${result.mergedCount}개 기존 단어 병합</span>`;
  } else {
    status.innerHTML = `<span class="status-ok">${newCount}개 단어 추가 완료</span>`;
  }
  setTimeout(() => Router.go('/alphabet'), 800);
}

// ---- 학습 모드 (낱말카드) ----

let suppressClickUntil = 0; // 스와이프 후 click 억제용 타임스탬프

const study = {
  letter: null,
  cards: [],
  originalCards: [],
  index: 0,
  flipped: false,
  shuffled: false,
  unknowns: new Set(),
  knowns: new Set(),
  answered: new Set(), // 직접 버튼을 누른 카드만
};

function renderStudy(letter) {
  const allCards = Storage.getAll();
  const isFav = letter && letter.toUpperCase() === 'FAV';
  // FAV이면 즐겨찾기, 알파벳이면 해당 글자, 없으면 전체
  const cards = isFav
    ? allCards.filter(c => c.favorite)
    : letter
      ? allCards.filter(c => c.term.charAt(0).toUpperCase() === letter.toUpperCase())
      : allCards;

  if (cards.length === 0) {
    Router.go(letter ? '/words/' + letter : '/');
    return;
  }

  study.letter = letter || null;
  study.originalCards = [...cards];
  study.cards = [...cards];
  study.index = 0;
  study.flipped = false;
  study.shuffled = false;
  study.unknowns = new Set(cards.map(c => c.id));
  study.knowns = new Set();
  study.answered = new Set();

  renderStudyUI();

  // 키보드 단축키 (iPad + 키보드 케이스 사용 시)
  const keyHandler = (e) => {
    switch (e.key) {
      case ' ':
      case 'Enter':
        e.preventDefault();
        flipCard();
        break;
      case 'ArrowLeft':
        prevCard();
        break;
      case 'ArrowRight':
        nextCard();
        break;
    }
  };

  document.addEventListener('keydown', keyHandler);
  setCleanup(() => document.removeEventListener('keydown', keyHandler));
}

function renderStudyUI(slideDirection) {
  // 스와이프 플래그 강제 리셋
  const card = study.cards[study.index];
  const progress = ((study.index + 1) / study.cards.length) * 100;

  $app.innerHTML = `
    <div class="study-container">
      <div class="study-header">
        <button class="btn-back" id="btn-exit">\u00D7</button>
        <span class="study-letter">${
          !study.letter ? '전체 낱말카드'
          : study.letter.toUpperCase() === 'FAV' ? '\u2605 낱말카드'
          : study.letter + ' 낱말카드'
        }</span>
        <div class="study-progress">
          <div class="study-progress-bar" style="width: ${progress}%"></div>
        </div>
        <span class="study-counter">
          ${study.index + 1} / ${study.cards.length}
        </span>
      </div>
      <div class="study-score">
        <span class="score-unknown">\u2717 ${study.unknowns.size}</span>
        <span class="score-known">\u2713 ${study.knowns.size}</span>
      </div>
      <div class="study-body" id="study-body">
        <div class="flashcard-container ${slideDirection || ''}" id="flashcard-tap">
          <div class="flashcard ${study.flipped ? 'flipped' : ''}" id="flashcard">
            <div class="flashcard-face flashcard-front">
              <div class="flashcard-label">용어</div>
              <div class="flashcard-text">${escapeHtml(card.term)}${card.count > 1 ? ` <span class="word-hit">\u00D7${card.count}</span>` : ''}</div>
              <button class="btn-fav-card ${card.favorite ? 'btn-fav-on' : ''}"
                id="btn-fav-front">${card.favorite ? '\u2605' : '\u2606'}</button>
              <div class="flashcard-hint">탭하여 뒤집기</div>
            </div>
            <div class="flashcard-face flashcard-back">
              <div class="flashcard-label">정의</div>
              <div class="flashcard-text">${formatDefinitionCard(card.definition)}</div>
              <div class="flashcard-hint">탭하여 뒤집기</div>
            </div>
          </div>
        </div>
      </div>
      <div class="study-answer">
        <button class="btn-answer btn-answer-no ${study.answered.has(card.id) && study.unknowns.has(card.id) ? 'btn-answer-pressed' : ''}"
          id="btn-unknown">몰라요</button>
        <button class="btn-answer btn-answer-yes ${study.answered.has(card.id) && study.knowns.has(card.id) ? 'btn-answer-pressed' : ''}"
          id="btn-known">알아요</button>
      </div>
      <p class="study-swipe-hint">좌우로 밀어서 넘기기 · 두 번 터치하면 별표</p>
      <div class="study-nav">
        <button class="btn-nav" id="btn-prev"
          ${study.index === 0 ? 'disabled' : ''}>\u25C0</button>
        <button class="btn-shuffle ${study.shuffled ? 'active' : ''}"
          id="btn-shuffle" title="셔플">🔀</button>
        <button class="btn-nav" id="btn-next"
          ${study.index === study.cards.length - 1 ? 'disabled' : ''}>\u25B6</button>
      </div>
    </div>
  `;

  // 카드 터치 로직: click으로 뒤집기, touchstart로 더블탭 감지
  const flashcardTap = document.getElementById('flashcard-tap');
  let cardLastTouch = 0;
  let isDoubleTap = false;

  // 더블탭 감지 (touchstart 기반 - swipe와 충돌 없음)
  flashcardTap.addEventListener('touchstart', (e) => {
    if (e.target.closest('.btn-fav-card')) return;
    const now = Date.now();
    if (now - cardLastTouch < 400) {
      isDoubleTap = true;
      // 첫 탭에서 뒤집힌 걸 되돌리고 별표 토글
      flipCard();
      const updated = Storage.toggleFavorite(study.cards[study.index].id);
      study.cards[study.index].favorite = updated.favorite;
      const favBtn = document.getElementById('btn-fav-front');
      if (favBtn) {
        favBtn.classList.toggle('btn-fav-on', updated.favorite);
        favBtn.textContent = updated.favorite ? '\u2605' : '\u2606';
      }
      cardLastTouch = 0;
    } else {
      isDoubleTap = false;
      cardLastTouch = now;
    }
  }, { passive: true });

  // 싱글탭 = 뒤집기 (click 기반 - swipe 후에도 안정적)
  flashcardTap.addEventListener('click', (e) => {
    if (e.target.closest('.btn-fav-card')) return;
    if (Date.now() < suppressClickUntil) return;
    if (isDoubleTap) { isDoubleTap = false; return; }
    flipCard();
  });

  // 별표 버튼 (앞면)
  const favBtn = document.getElementById('btn-fav-front');
  if (favBtn) {
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const updated = Storage.toggleFavorite(study.cards[study.index].id);
      study.cards[study.index].favorite = updated.favorite;
      favBtn.classList.toggle('btn-fav-on', updated.favorite);
      favBtn.textContent = updated.favorite ? '\u2605' : '\u2606';
    });
  }
  document.getElementById('btn-exit').addEventListener('click', () =>
    Router.go(study.letter ? '/words/' + study.letter : '/alphabet')
  );
  document.getElementById('btn-prev').addEventListener('click', prevCard);
  document.getElementById('btn-next').addEventListener('click', nextCard);
  document.getElementById('btn-shuffle').addEventListener('click', toggleShuffle);

  // 알아요/몰라요 버튼
  const btnKnown = document.getElementById('btn-known');
  const btnUnknown = document.getElementById('btn-unknown');
  function lockAnswerBtns() {
    btnKnown.disabled = true;
    btnUnknown.disabled = true;
  }
  btnKnown.addEventListener('click', () => {
    const id = study.cards[study.index].id;
    study.unknowns.delete(id);
    study.knowns.add(id);
    study.answered.add(id);
    btnKnown.classList.add('btn-answer-pressed');
    lockAnswerBtns();
    setTimeout(() => goNextOrFinish(), 200);
  });
  btnUnknown.addEventListener('click', () => {
    const id = study.cards[study.index].id;
    study.knowns.delete(id);
    study.unknowns.add(id);
    study.answered.add(id);
    btnUnknown.classList.add('btn-answer-pressed');
    lockAnswerBtns();
    setTimeout(() => goNextOrFinish(), 200);
  });

  initSwipe(document.getElementById('study-body'));
}

function flipCard() {
  if (Date.now() < suppressClickUntil) return;
  study.flipped = !study.flipped;
  const flashcard = document.getElementById('flashcard');
  if (flashcard) flashcard.classList.toggle('flipped', study.flipped);
}

function prevCard() {
  if (study.index <= 0) return;
  study.index--;
  study.flipped = false;
  renderStudyUI('slide-in-left');
}

function nextCard() {
  if (study.index >= study.cards.length - 1) return;
  study.index++;
  study.flipped = false;
  renderStudyUI('slide-in-right');
}

// 알아요/몰라요 후 다음 카드 또는 완료 화면
function goNextOrFinish() {
  if (study.index < study.cards.length - 1) {
    study.index++;
    study.flipped = false;
    renderStudyUI('slide-in-right');
  } else {
    // 모든 카드 완료
    showStudyComplete();
  }
}

// 학습 완료 화면
function showStudyComplete() {
  const unknownCards = study.cards.filter(c => study.unknowns.has(c.id));
  const knownCount = study.knowns.size;
  const letterLabel = !study.letter ? '전체'
    : study.letter.toUpperCase() === 'FAV' ? '\u2605'
    : study.letter;

  $app.innerHTML = `
    <div class="study-container">
      <div class="study-complete">
        <h2>학습 완료!</h2>
        <div class="complete-stats">
          <div class="complete-stat">
            <span class="complete-stat-num">${study.cards.length}</span>
            <span class="complete-stat-label">전체</span>
          </div>
          <div class="complete-stat complete-stat-known">
            <span class="complete-stat-num">${knownCount}</span>
            <span class="complete-stat-label">알아요</span>
          </div>
          <div class="complete-stat complete-stat-unknown">
            <span class="complete-stat-num">${unknownCards.length}</span>
            <span class="complete-stat-label">몰라요</span>
          </div>
        </div>
        ${unknownCards.length > 0 ? `
          <button class="btn-study-again" id="btn-retry-unknown">
            몰라요 ${unknownCards.length}개만 다시 학습
          </button>
        ` : `
          <p class="complete-msg">모든 단어를 다 알아요!</p>
        `}
        <div class="complete-actions">
          <button class="btn-restart" id="btn-restart">처음부터 다시</button>
          <button class="btn-go-back" id="btn-go-back">돌아가기</button>
        </div>
      </div>
    </div>
  `;

  // 몰라요 단어만 다시 학습
  if (unknownCards.length > 0) {
    document.getElementById('btn-retry-unknown').addEventListener('click', () => {
      study.cards = shuffleArray(unknownCards);
      study.originalCards = [...study.cards];
      study.index = 0;
      study.flipped = false;
      study.shuffled = false;
      study.unknowns = new Set(study.cards.map(c => c.id));
      study.knowns = new Set();
      study.answered = new Set();
      renderStudyUI();
    });
  }

  // 처음부터 다시
  document.getElementById('btn-restart').addEventListener('click', () => {
    renderStudy(study.letter);
  });

  // 돌아가기
  document.getElementById('btn-go-back').addEventListener('click', () => {
    Router.go(study.letter ? '/words/' + study.letter : '/alphabet');
  });
}

function toggleShuffle() {
  study.shuffled = !study.shuffled;
  study.cards = study.shuffled
    ? shuffleArray(study.originalCards)
    : [...study.originalCards];
  study.index = 0;
  study.flipped = false;
  renderStudyUI();
}

function initSwipe(element) {
  let startX = 0;
  let startY = 0;

  element.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  element.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;

    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      suppressClickUntil = Date.now() + 350;
      if (dx < 0) nextCard();
      else prevCard();
    }
  }, { passive: true });
}

// ============================================================
// 5. 시드 데이터 + 초기화
// ============================================================

// 첫 실행 시 샘플 단어 로드 (seeded 플래그로 중복 방지)
// 사용자가 모든 단어를 삭제해도 다시 생기지 않음
const SEED_WORDS = `
organized - 정리된
sound - 올바른, 건실한
last minute - 마지막 순간
put off - 미루다, 연기하다
compact - 빽빽한, 꽉 채우다
plaza - 광장
stationary store - 문구점
on duty 근무 중의
appointment - 예약, 약속, 운명
coordinator - 진행자
securely - 단단히, 확실하게
eat out - 외식하다
capture - (사진 등으로) 기록하다
run out - 부족하다, 다하다
twist - (발목, 손목 등을) 삐다, 접질리다
alternative - 바꿀 수 있는, 대안적인
rustling - 바스락거리는
cope - 대처하다
contortion - 일그러짐, 뒤틀림
observe - 왈, 말하다, 주장하다
boredom - 지루함
filter out - 걸러내다
grief - 슬픔
overload - 과중하게 부담시키다
observation - 관찰, 주목
align - 같은 태도를 취하게 하다, 나란히 하다, 부합하다, 잘 들어맞다
tendency - 성향
naturally 본래 ~이다/하다
A be involved in B - A가 B에 관여하다
real-life - 실생활의
code - 문화
require - 필요하다
set - 집합
prescribed - 정해진
conversely - 역으로, 반대로
literacy - 문해 능력
elicit - 불러 일으키다
close - 면밀한
existing - 기존의
mapping - 파악하다
positivist - 실증주의자의
inactive - 수동적인, 활발하지 않은
critical - 중요한, 비판적인
prompt - ~하도록 만들다
gathering - 수집
seriously - 진지하게
filedworker - 현장직
subject - 연구대상
modernist - 근대적
matter - 물질, 물체
live - 살아 있다
involve - 수반하다
ignore - 간과하다
frame - 만들다, ~의 틀을 잡다
embrace - 포괄하다
underlying - 근본적인
induction 귀납
ambient - 주변의
sample - 표본
draw - 추출하다
hold - 성립하다
mothertongue - 모국어
uncover - 찾아내다
in a way that - ~한 방식으로
leap on - ~로 뛰어들다, ~로 빠지다
issue with A - A의 문제점
finance - 자금, 재원
activist - (정치, 사회 운동) 활동가, 운동가
disadvantage - 불이익, 손해
primary education - 초등 교육
serve as A - A를 역임하다, A의 지위를 얻다, A의 임무를 갖다, A로서 활동하다
set up - 구축하다
national - 전국적
temporary - 임시의
give a funeral - 장례를 치르다
subject line - 제목
host - 개최하다, 진행자
youth - 청소년
regulate - 조절하다, 규제하다
override - ~을 압도하다, 무시하다, 철회
impulse - 충동
miserable - 비참한
confront - 마주하다
cultures - 문화권
proliferation - 확산, 급증
reciprocal - 상호 간의
marginal - 미미한, 한계의
feast - 성찬, 마음껏 먹다, 대접하다
individual - 개별, 개체
unit - 단위
vampire - 흡혈의
sustenance - 음식물
shift - 서로 바뀌다
extract - 발생하다
the greatest possible - 가능한 한 최대의
utility - 효용
involvement - 몰두, 열중
identification - 동일시, 신원 확인
divine - 신성한, 아주 훌륭한
exceptional - 예외적인, 드문
thought - 사상
body - 양, 수량
belief - 신념
accomplish - ~을 이루다, 달성하다
worldview - 세계관
web - 설계망
sacred - 신성한
peak - 정점
supreme - 최고의
place - 지위
carry out - 수행하다
mastery - 숙달
practice - 실천
rightly - 제대로
talk - 언급하다
embed - 내재하다
work out - 찾아내다, 알아내다
innate - 선천적인
hardwired - 타고나는
reluctant - 꺼리는, 주저하는
minority - 소수
work - 효과적이다
join in - 참여하다
inherent - 본질적인
commons - 공유지
deterrent - 방해물
can't be bothered - 굳이 하려고 하지 않다
manufacturers - 제조업체
free riders - 무임승차자
useful life - (제품의) 수명
undercut - 경쟁자보다 싸게 팔다
be undercut - 가격에서 밀리다
medium - 매개체
disposition - 성향
life - 생명력
give - 부여하다
right - 적절한
stiff - 뻣뻣한
offering - 배려, 베푸는 행위
need - 필요성
exploit - 명시하다, 명시적으로 규정하다
enforce - 강화하다
implicitly - 암묵적으로
existence - 공존
open - 개방적인
survive - 존속하다
virtue - 미덕, 선
grudging - 마지못해 하는
on risk - 위험을 감수하며
around - ~에 관한
set - 정하다
terms - 조건
responsible for - ~에 대한 책임이 있다
solely - 전적으로
wage - 임금
N-mounted - N이 부착된
encourage - 권장하다
prevent - 막는
embrace - 받아들이다, 수용하다
burdensome - 부담스러운, 성가신
white worker - 사무직 노동자
blue-collar worker - 육체노동자
outlook - 관점
millenial generation - 밀레니엄 세대
self-reliant - 자립적인
portray - 묘사하다
hip - 세련된
neoclassical - 신고전주의
welfare states - 복지 국가
goods - 재화
healthcare - 의료
political science - 정치학
public goods - 공공재
departure from - ~에서 벗어난
blind spots - 맹점, 사각지대
mainstream - 주류
adhere - 고수하다, 충실하다
have fun - 재미 있는
spot - 발견하다
reveal - 나오다, 등장하다
tidy up - 정리하다
strke - (생각 등이) 떠오르다
conditioning - 조건 형성, 훈련
great - 뛰어난
power - 능력
breast milk - 모유
fussy - 까다로워지다
substance - 물질, 실체, 본질
amniotic fluid - 양수
breastfeed - 모유를 먹이다
in the profession - 직업에 종사하는
in bad shape - 상태가 좋지 않은
measuring - 판단하다
resource - 자원을 투자하다
tolerate - 용납하다
momentum - 추진력, 힘
restore - 회복하다
transition - 전환, 과도기
in place - 자리 잡다
process - 처리하다
tonality - 음조, 색조
meter - 박자
account for - 설명하다
give rise to - 일으키다, 낳다
probalitisc - 확률적인, 개연론의
load - 의미
Ads - 광고
spouse - 배우자
sequence - 결과
other than - ~외에는
competence - 역량, 능력, 권한
ritual - 의식, 절차, 의례적인
incorporate - 포함하다, 설립하다
vulnerable to A - A에 취약하다
margin - 주변부, 여백, 이윤, 수익, 가장자리
explotitation - 개발
reverse - 역으로
research - 조사하다
alter - 고치다
circulate - 유포하다
wide-awake - 완전히 잠이 깨다
unsound - 부적절한, 오류가 있는
therapeutic - 치료상의, 치료법의
intervention - 개입, 간섭, 중재
agent - 병원체
culture - 배양하다, 문화, 교양
prohibitive - 엄두도 못 낼 정도로 비싼, 금지하는
denature - 변성시키다, 특징을 없애다
pathogen - 병원균
address - 다루다
proposal - 제안
publicly - 공개적으로
put at risk - 위험에 빠뜨리다
epistemic - 인식론적인, 지식에 관한
compromise - 위태롭게 하다
cluster - 모이다, 무리를 이루다
deliberative - 토의하는, 깊이 생각하는
at stake - 성패가 달린, 위태로운
weed out - 제거하다, 뽑아버리다
beat the record - 기록을 경신하다
tide - 조류, 조수
promote - 촉진하다, 홍보하다
risk - 위험, 위험 요소, 위험을 무릅쓰다
rule-breaking - 규칙 위반
ensure - 보장하다, 확실히 하다
tracking - 추적, 탐지, 조사, 이력
luxury - 명품, 사치, 사치스러운
point - 지점
totalize - 합계하다, 결산하다, 요약하다
regime - 체제, 정권
site - 현장, 장소, 위치, 유적
routine - 일과, 일상적인 일, 일상, 일상의
presence - 있음, 존재(함), 실재, 출석
task - 과업
practitional - 실무자
academician - 학술 위원
operational - 작업의, 운영상의
integrated - 통합된, 평등한, 통합적인
labor - 노동력
stuff - 물건, 것, 재료, 넣다
induce - 야기하다
misplace A on B - A를 B에 잘못 두다/놓다
input - 투입, 입력, 투입하다
obsession - 강박 관념, 사로잡힘
closely - 밀접하게
herb - 풀
gracefully - 우아하게
clothing - 덮개
trunk - (나무의) 몸통, 줄기
seaweed - 해조, 해초
yield - 굴복하다
continuous - 끊임없는
undistorted - 정상적인
well-shaped - 균형 잡힌, 모양이 좋은
representative - 전형, 전형의
kind - (동식물의) 종
scale - 비늘, 비늘을 벗기다, 규모, 척도
virtual - 가상의, 사실상의
correlation - 상관관계, 연관성
avatar - 분신
protest - 항의하다, 이의를 제기하다, 항의
nature - 특징, 본성, 자연
firmly - 확고히, 단호히
continuity - 지속성, 연속성
maintenance - 관리, 보수
mass - 대량의, 대량
ship to - ~로 발송하다
affect - 충격을 주다
seat - 앉다, 자리에 앉히다
business - 일상적인
vague - 막연한, 희미한
monetary - 통화, 화폐
preconceived - 사전에 형성된
conclusions - 판단, 결론
raw material - 원료, 원자재
aid - 보조수단, 원조, 돕다
absolutes - 절대적인 것
suppose - 추정하다, 생각하다
consequence - 결과, 결말, 영향력
concerns - 관심사
frequently - 자주
ethics - 윤리
mortality - 죽을 운명
convictional - 신념의, 유죄의
individualistic - 개인주의적인, 개성적인
find time - 시간을 내다
community-centered - 공동체 중심의
nationalist - 민족주의자, 민족주의의
mediate - 중재하다, 이뤄내다
implicate - 관련시키다, 연루시키다
globalisation - 세계화
radical - 급진적인
commonplace - 평범한
framework - 틀
stream - 흐름
enrich - 풍요롭게 하다, 풍부하게 만들다
tumultuous - 격동의, 떠들썩한
forerunner - 선구자, 전조
unremarkable - 사람의 주의를 끌지 않은, 평범한
nuance - 뉘앙스, 미묘한 차이
display - 표현
heighten - 고조시키다
lossless - 손실이 없는, 무손실의
universal - 보편적인
affliation - 소속, 제휴
elaborate - 정교하게 만들어 내다
misleading - 오해의 소지가 있는, 오도하는
clean up - 정화
represent - 대변하다
underpin - 뒷받침하다
externality - 외부 효과, 외부성
institution - 제도, 기관
detriment - 손해
proximity - 밀접함
findings - 연구 결과
arousal - 각성, 자극, 흥분
tailor - 조정하다, 맞추다
manifestation - 징후
literate - 글을 읽고 쓰는
novelist - 소설가
manuscript - 원고
fallacy - 오류
inscribe - 새기다, 쓰다
costly - 비용이 많이 드는
guide - 지표
lessons - 교훈
recreation - 휴양적으로
mammal - 표유류의
game species - 사냥감 종
modification - 변화
genuine - 진정한, 진품의
savor - 즐기다
fellow - 동료
animating - 고무적인
idea - 개념
Jews - 유대인의
mistreatment - 부당한 대우
permissible - 허용되는
constraint - 제약, 제한, 통제
imperative - 필요, 의무
clan - 씨족, 집단
surviving - 잔존해 있는, 살아남은
pale - 희미한, 흐릿한
ecological - 생태학적인, 환경의
remains - 유해, 유적
a bit of — 약간의
a figure of speech — 비유적 표현
a great deal — 많은
a head start — 유리한 시작
a host of — 많은
a little — 거의 ~않다
a wave of — 집단적인, 물밀듯이 밀려드는, ~의 흐름
a wealth of — 수많은
abbreviate — 축약하다, 생략하다
abide — 따르다
aboriginal — 원주민의, 토착의
abrupt — 갑작스러운, 퉁명스러운
absentminded — 멍한, 방심하고 있는
absurd — 터무니없는, 불합리한
abusive — 남용하는, 학대하는, 가학적인, 모욕적인
academic — 학문적인, 이론적인, 학업의
acclaim — 찬사
acclimatize — 적응하다
accommodate — 수용하다, 숙박시키다, 설명하다, (요구에) 맞추다, 부응하다
accommodation — 적응
accommodations — 숙박시설
accompany — 동반하다
accomplice — 공범
account — 계정, 설명, 이야기, 장부, 간주하다, 차지하다
account for — (부분을) 차지하다, 설명하다, 고려하다
accountability — 책임, 의무, 책임감
accountant — 회계사
accrue — 누적되다
accumulate — 축적하다, 모으다
accusation — 혐의, 고발, 비난
accuse — 고발하다, 비난하다
accustomed to — ~에 익숙한
acid — 산, 산성
acquaint — 알게 하다
acrobat — 곡예사
activity — 활동
actually — 실제로, 사실은
acuity — 예리함, 예민함
acute — 극심한, 예리한, 심각한, 급성의
adaptability — 적용 가능성
adaptation — 각색, 적응
adaptive — 적응성의, 적응할 수 있는
add to — ~을 늘리다, 증가시키다
add up — 합산하다
add up to — 귀결되다
address — 대응하다, 다루다, 연설, 부르다, 말을 걸다
address a to b — a를 b에게 전달하다
addressing — 발표하다, 다루다, 해결하다
adept — 능숙한
adequate — 충분한
adjacent to — 인접한, 가까운
adjunct — 부속물
adjust — 적응하다, 조정하다
administer — 투여하다, 가하다, 집행하다, 관리하다
administrate — 관리하다
admiral — 제독
admiration — 존중
admire — 감탄하다, 존경하다, 칭송하다
admission — 입장표, 입학
admit — 인정하다, 허가하다
admittedly — 인정하건대
adolescence — 청소년기, 사춘기
adopt — 취하다
adore — 숭배하다, 동경하다, 사모하다
adorn — 장식하다
advance — 미리, 사전에, 반영하다, 증진시키다
advantageous — 이로운, 유익한
adversary — 적, 상대, 상대편
adverse — 부정적인, 불리한
advocate — 옹호하다
aerial — 항공의, 공중의
affection — 애정
affectively — 감정적으로
`.trim();

// 데이터 마이그레이션 & 시드
// v2: 이전 세트 기반 구조(flashcard_sets)에서 단일 단어장(flashcard_cards)으로 전환
function migrateAndSeed() {
  const DATA_VERSION = 'flashcard_data_v3';

  if (localStorage.getItem(DATA_VERSION)) {
    // 이미 마이그레이션 완료. 기존 카드에 누락된 필드만 보정
    const cards = Storage.getAll();
    let needsSave = false;
    cards.forEach(c => {
      if (c.count === undefined) { c.count = 1; needsSave = true; }
      if (c.favorite === undefined) { c.favorite = false; needsSave = true; }
    });
    if (needsSave) Storage._save(cards);
    return;
  }

  // 첫 실행: 기존 데이터가 있으면 보존, 없으면 시드
  const existing = Storage.getAll();
  // 이전 세트 기반 구조 정리
  localStorage.removeItem('flashcard_sets');
  localStorage.removeItem('flashcard_seeded');

  if (existing.length > 0) {
    // 기존 사용자 데이터 유지, 누락 필드만 보정
    existing.forEach(c => {
      if (c.count === undefined) c.count = 1;
      if (c.favorite === undefined) c.favorite = false;
    });
    Storage._save(existing);
  } else {
    // 데이터 없으면 시드
    Storage.replaceAll(parseBulkWords(SEED_WORDS));
  }

  localStorage.setItem(DATA_VERSION, 'true');
}

// Service Worker 등록 (오프라인 지원)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

migrateAndSeed();
Storage.dedup(); // 중복 단어 자동 제거

// 리다이렉트 로그인 결과 처리 (Google 로그인 후 앱으로 돌아왔을 때)
if (fbAuth) {
  fbAuth.getRedirectResult().then(result => {
    if (result && result.user) {
      Sync.syncFromCloud().then(() => {
        Router.handle(); // 화면 새로고침
      });
    }
  }).catch(() => {});

  // 로그인 상태 변화 감지
  fbAuth.onAuthStateChanged(user => {
    if (user) Sync.syncFromCloud();
  });
}

Router.init();
