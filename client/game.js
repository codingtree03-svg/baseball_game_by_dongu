const socket = io();

let myGameId = null;
let myRole = null; 
let currentPing = 0;
let isBallInFlight = false;
let pitchStartTime = 0;
let pitchDuration = 2000; // 기본 투구 비행시간 2000ms
let pitchType = 'fast';

let animationFrameId = null;

// DOM 요소 래핑
const btnJoin = document.getElementById('btn-join');
const matchStatus = document.getElementById('match-status');
const matchScreen = document.getElementById('match-screen');
const gameScreen = document.getElementById('game-screen');
const roleBanner = document.getElementById('role-banner');
const gameMessage = document.getElementById('game-message');
const ballEl = document.getElementById('ball');
const batEl = document.getElementById('bat');
const btnSwing = document.getElementById('btn-swing');

// 정기적 네트워크 핀(Ping) 측정 루프
setInterval(() => {
    const start = Date.now();
    socket.emit('ping_test', start);
}, 2000);

socket.on('pong_test', (startTime) => {
    currentPing = Date.now() - startTime;
    document.getElementById('ping-value').innerText = currentPing;
});

// 매치메이킹 이벤트 바인딩
btnJoin.addEventListener('click', () => {
    socket.emit('join_match');
    btnJoin.disabled = true;
});

socket.on('waiting_match', () => {
    matchStatus.innerText = "다른 플레이어를 매칭하고 있습니다...";
});

socket.on('match_found', (data) => {
    myGameId = data.gameId;
    myRole = data.role;

    matchScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');

    roleBanner.innerText = `당신의 역할은 [${myRole === 'pitcher' ? '투수' : '타자'}] 입니다!`;
    updateUIControls();
});

// 인터페이스 제어권 업데이트
function updateUIControls() {
    if (myRole === 'pitcher') {
        document.getElementById('pitcher-controls').classList.remove('hidden');
        document.getElementById('batter-controls').classList.add('hidden');
    } else {
        document.getElementById('pitcher-controls').classList.add('hidden');
        document.getElementById('batter-controls').classList.remove('hidden');
    }
}

// 투수 액션 송신
function throwPitch(type) {
    const speed = type === 'fast' ? 1.5 : 1.0; // 속도 배율
    socket.emit('throw_pitch', { gameId: myGameId, type, speed });
}

// 투구 애니메이션 및 실시간 물리 처리 (동격화 핵심)
socket.on('pitch_thrown', (data) => {
    isBallInFlight = true;
    pitchType = data.type;
    // 상대방의 Ping 절반값을 더해 애니메이션 시작 시각 보정 (동기화 레이턴시 상쇄)
    pitchStartTime = data.startTime + (currentPing / 2);
    pitchDuration = data.type === 'fast' ? 1200 : 2000; 

    ballEl.style.display = 'block';
    gameMessage.innerText = `${data.type === 'fast' ? '강속구' : '변화구'}가 날아옵니다!`;
    
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    renderBall();
});

// 공의 움직임 및 탄도 렌더링 함수
function renderBall() {
    if (!isBallInFlight) return;

    const now = Date.now();
    const elapsed = now - pitchStartTime;
    const progress = Math.min(elapsed / pitchDuration, 1);

    // 투수 플레이트(55px)에서 스트라이크 존 앞(330px)까지 y축 이동 물리
    const startY = 55;
    const endY = 330;
    let currentY = startY + (endY - startY) * progress;

    // x축 변화구 커브 궤적 물리 계산
    let currentX = 50; 
    if (pitchType === 'curve') {
        // 사인파 형태 궤적 적용
        currentX += Math.sin(progress * Math.PI) * 15;
    }

    ballEl.style.top = `${currentY}px`;
    ballEl.style.left = `${currentX}%`;

    // 스트라이크존 통과 시 아웃/패스 판정 제어
    if (progress >= 1) {
        isBallInFlight = false;
        ballEl.style.display = 'none';
        if (myRole === 'pitcher') {
            // 투수가 스트라이크/볼 판정 최종 전송 책임을 가짐
            const outcome = pitchType === 'fast' ? 'strike' : 'ball';
            socket.emit('submit_result', { gameId: myGameId, outcome });
        }
    } else {
        animationFrameId = requestAnimationFrame(renderBall);
    }
}

// 타자 배트 스윙 이벤트 처리
btnSwing.addEventListener('click', () => {
    if (!isBallInFlight) return;
    
    batEl.classList.add('swinging');
    setTimeout(() => batEl.classList.remove('swinging'), 150);

    const clientSwingTime = Date.now();
    socket.emit('swing_bat', {
        gameId: myGameId,
        clientSwingTime,
        clientPing: currentPing
    });
});

// 타격 판정 및 피드백 처리
socket.on('pitch_result', (data) => {
    isBallInFlight = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    ballEl.style.display = 'none';

    // 타격 타이밍 계산 (서버 투구 시작 시각 기준 경과시간 산출)
    const exactElapsed = data.clientSwingTime - pitchStartTime - (data.clientPing / 2);
    
    let outcome = 'miss';
    // 타격 유효 밀리초 구간 검증 (Hit window)
    const perfectHitZone = pitchDuration * 0.85; // 홈플레이트 도달 임계 타이밍
    const windowSize = 150; // 판정 허용 오차 오프셋

    if (Math.abs(exactElapsed - perfectHitZone) < windowSize / 3) {
        outcome = 'home_run';
    } else if (Math.abs(exactElapsed - perfectHitZone) < windowSize) {
        outcome = 'hit';
    } else {
        outcome = 'strike';
    }

    gameMessage.innerText = outcome === 'home_run' ? '홈런!!! 🎉' : (outcome === 'hit' ? '안타! ⚾' : '헛스윙 스트라이크!');

    if (myRole === 'pitcher') {
        setTimeout(() => {
            socket.emit('submit_result', { gameId: myGameId, outcome });
        }, 1500);
    }
});

// 실시간 스코어보드 및 전광판 정보 갱신
socket.on('update_status', (game) => {
    document.getElementById('info-inning').innerText = game.inning;
    document.getElementById('info-outs').innerText = game.outs;
    document.getElementById('info-strikes').innerText = game.strikes;
    document.getElementById('info-balls').innerText = game.balls;

    if (myRole === 'pitcher') {
        document.getElementById('my-score').innerText = game.scores.pitcher;
        document.getElementById('op-score').innerText = game.scores.batter;
    } else {
        document.getElementById('my-score').innerText = game.scores.batter;
        document.getElementById('op-score').innerText = game.scores.pitcher;
    }
});

// 이닝 교대 이벤트 처리
socket.on('role_swapped', (data) => {
    myRole = socket.id === data.pitcher ? 'pitcher' : 'batter';
    roleBanner.innerText = `공수교대! 당신의 역할은 [${myRole === 'pitcher' ? '투수' : '타자'}] 입니다!`;
    updateUIControls();
});

socket.on('opponent_disconnected', () => {
    alert('상대방의 연결이 끊어졌습니다. 대기실로 이동합니다.');
    location.reload();
});
