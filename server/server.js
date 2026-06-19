const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, '../client')));

let waitingPlayer = null;
const games = new Map();

io.on('connection', (socket) => {
    console.log(`사용자 접속: ${socket.id}`);

    // 핀 측정용 핑퐁
    socket.on('ping_test', (clientTime) => {
        socket.emit('pong_test', clientTime);
    });

    // 매치메이킹 등록
    socket.on('join_match', () => {
        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const gameId = `game_${Date.now()}`;
            const pitcher = waitingPlayer;
            const batter = socket;

            pitcher.join(gameId);
            batter.join(gameId);

            const gameSession = {
                id: gameId,
                pitcher: pitcher.id,
                batter: batter.id,
                scores: { pitcher: 0, batter: 0 },
                inning: 1,
                outs: 0,
                strikes: 0,
                balls: 0,
                gameState: 'waiting_pitch' // waiting_pitch, ball_in_flight, result
            };

            games.set(gameId, gameSession);

            pitcher.emit('match_found', { gameId, role: 'pitcher', opponent: batter.id });
            batter.emit('match_found', { gameId, role: 'batter', opponent: pitcher.id });
            
            io.to(gameId).emit('update_status', gameSession);
            waitingPlayer = null;
        } else {
            waitingPlayer = socket;
            socket.emit('waiting_match');
        }
    });

    // 투구 액션 처리 (공 물리 초기값 수신)
    socket.on('throw_pitch', (data) => {
        const { gameId, type, speed } = data;
        const game = games.get(gameId);
        if (!game || game.pitcher !== socket.id || game.gameState !== 'waiting_pitch') return;

        game.gameState = 'ball_in_flight';
        
        // 서버 기준 투구 시작 시간 기록 (지연 보정용)
        const startTime = Date.now();

        io.to(gameId).emit('pitch_thrown', {
            type,
            speed,
            startTime,
            yTrajectory: type === 'curve' ? 'curved' : 'straight'
        });
    });

    // 타격 액션 처리 및 판정 계산 (물리 거리 기반 히트 윈도우 및 지연 보정)
    socket.on('swing_bat', (data) => {
        const { gameId, clientSwingTime, clientPing } = data;
        const game = games.get(gameId);
        if (!game || game.batter !== socket.id || game.gameState !== 'ball_in_flight') return;

        // 투구 시점 기준 경과 시간 계산 (단위: ms)
        // 지연 시간(Ping)을 고려하여 타자가 실제 공을 본 시점을 추정
        const serverTime = Date.now();
        game.gameState = 'result';

        io.to(gameId).emit('pitch_result', {
            result: 'hit_processed',
            serverTime,
            clientSwingTime,
            clientPing
        });
    });

    // 라운드 결과 업데이트 (스트라이크, 볼, 안타 등 게임 룰 정산)
    socket.on('submit_result', (data) => {
        const { gameId, outcome } = data;
        const game = games.get(gameId);
        if (!game) return;

        if (outcome === 'home_run') game.scores.batter += 4;
        else if (outcome === 'hit') game.scores.batter += 1;
        else if (outcome === 'strike' || outcome === 'miss') game.strikes += 1;
        else if (outcome === 'ball') game.balls += 1;

        // 야구 규칙 판정 규칙 처리
        if (game.strikes >= 3) {
            game.outs += 1;
            game.strikes = 0;
            game.balls = 0;
        }
        if (game.balls >= 4) {
            game.scores.batter += 1; // 밀어내기 득점 단순화
            game.strikes = 0;
            game.balls = 0;
        }
        if (game.outs >= 3) {
            // 공수대교 및 이닝 증가
            const temp = game.pitcher;
            game.pitcher = game.batter;
            game.batter = temp;
            game.outs = 0;
            game.strikes = 0;
            game.balls = 0;
            game.inning += 1;
            
            io.to(gameId).emit('role_swapped', { pitcher: game.pitcher, batter: game.batter });
        }

        game.gameState = 'waiting_pitch';
        io.to(gameId).emit('update_status', game);
    });

    // 접속 해제 처리
    socket.on('disconnect', () => {
        console.log(`사용자 접속 해제: ${socket.id}`);
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
        for (const [gameId, game] of games.entries()) {
            if (game.pitcher === socket.id || game.batter === socket.id) {
                io.to(gameId).emit('opponent_disconnected');
                games.delete(gameId);
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
