import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@telegram-apps/telegram-ui';
import { t } from '../i18n/index.js';

const SIZE = 16;
const CELL = 18;
const STEP_MS = 140;

type Dir = 'up' | 'down' | 'left' | 'right';
type Point = { x: number; y: number };
const MOVE: Record<Dir, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };

function freeCell(snake: Point[]): Point {
  for (;;) {
    const p = { x: Math.floor(Math.random() * SIZE), y: Math.floor(Math.random() * SIZE) };
    if (!snake.some((s) => s.x === p.x && s.y === p.y)) return p;
  }
}

/** A small snake, to pass the time at the entrance (like a browser's offline game). */
export function SnakeGame(): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({
    snake: [{ x: 8, y: 8 }] as Point[],
    dir: 'right' as Dir,
    next: 'right' as Dir,
    food: { x: 12, y: 8 } as Point,
  });
  const [running, setRunning] = useState(false);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);

  const draw = useCallback(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(document.body);
    const fg = css.getPropertyValue('--tgui--link_color').trim() || '#2481cc';
    const bg = css.getPropertyValue('--tgui--secondary_bg_color').trim() || '#f1f1f1';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE * CELL, SIZE * CELL);
    const { snake, food } = state.current;
    ctx.fillStyle = '#e5533d';
    ctx.beginPath();
    ctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = fg;
    for (const s of snake) ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
  }, []);

  const turn = useCallback((d: Dir) => {
    if (d !== OPPOSITE[state.current.dir]) state.current.next = d;
  }, []);

  const restart = (): void => {
    const snake = [{ x: 8, y: 8 }];
    state.current = { snake, dir: 'right', next: 'right', food: freeCell(snake) };
    setScore(0);
    setRunning(true);
  };

  useEffect(draw, [draw]);

  useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => {
      const st = state.current;
      st.dir = st.next;
      const head = st.snake[0]!;
      const next = { x: head.x + MOVE[st.dir].x, y: head.y + MOVE[st.dir].y };
      const hit =
        next.x < 0 || next.y < 0 || next.x >= SIZE || next.y >= SIZE || st.snake.some((s) => s.x === next.x && s.y === next.y);
      if (hit) {
        setRunning(false);
        setBest((b) => Math.max(b, st.snake.length - 1));
        return;
      }
      st.snake.unshift(next);
      if (next.x === st.food.x && next.y === st.food.y) {
        st.food = freeCell(st.snake);
        setScore(st.snake.length - 1);
      } else {
        st.snake.pop();
      }
      draw();
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, [running, draw]);

  // Arrow keys, and swipes on the board.
  useEffect(() => {
    const keys: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    const onKey = (e: KeyboardEvent): void => {
      const d = keys[e.key];
      if (d && running) {
        e.preventDefault();
        turn(d);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, turn]);
  const touch = useRef<Point | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 16 }}>
      <span className="gb-hint">
        🐍 {score}
        {best > 0 ? ` · ${t('gate.best', { n: best })}` : ''}
      </span>
      <canvas
        ref={canvas}
        width={SIZE * CELL}
        height={SIZE * CELL}
        style={{ borderRadius: 12, touchAction: 'none', maxWidth: '100%' }}
        onTouchStart={(e) => {
          const p = e.touches[0];
          if (p) touch.current = { x: p.clientX, y: p.clientY };
        }}
        onTouchEnd={(e) => {
          const p = e.changedTouches[0];
          const from = touch.current;
          touch.current = null;
          if (!p || !from) return;
          const dx = p.clientX - from.x;
          const dy = p.clientY - from.y;
          if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
          turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
        }}
      />
      {running ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 56px)', gap: 6 }}>
          <span />
          <Button size="s" mode="bezeled" onClick={() => turn('up')}>▲</Button>
          <span />
          <Button size="s" mode="bezeled" onClick={() => turn('left')}>◀</Button>
          <Button size="s" mode="bezeled" onClick={() => turn('down')}>▼</Button>
          <Button size="s" mode="bezeled" onClick={() => turn('right')}>▶</Button>
        </div>
      ) : (
        <Button size="s" onClick={restart}>
          {t('gate.play')}
        </Button>
      )}
    </div>
  );
}
