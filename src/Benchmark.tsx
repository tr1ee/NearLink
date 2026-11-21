import { useEffect, useRef } from "react";
export default function Benchmark() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!,
      ctx = canvas.getContext("2d", { alpha: false })!;
    let frame = 0,
      raf = 0,
      clicks = 0;
    const resize = () => {
      canvas.width = Math.round(innerWidth * devicePixelRatio);
      canvas.height = Math.round(innerHeight * devicePixelRatio);
    };
    resize();
    window.addEventListener("resize", resize);
    const click = () => (clicks = (clicks + 1) & 65535);
    canvas.addEventListener("mousedown", click);
    const draw = () => {
      const w = canvas.width,
        h = canvas.height;
      frame++;
      ctx.fillStyle = "#122435";
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < 8; y++) {
        ctx.fillStyle = `hsl(${(frame + y * 35) % 360} 48% 44%)`;
        ctx.fillRect(
          ((frame * 6 + y * 70) % (w + 300)) - 300,
          h * 0.15 + y * h * 0.09,
          w * 0.3,
          h * 0.05,
        );
      }
      ctx.fillStyle = "#fff";
      ctx.font = `${h * 0.035}px sans-serif`;
      ctx.fillText("NearLink 动态性能测试", w * 0.08, h * 0.12);
      ctx.font = `${h * 0.018}px sans-serif`;
      ctx.fillText(
        `${w} × ${h}   绘制帧 ${frame}   输入响应 ${clicks}`,
        w * 0.08,
        h * 0.9,
      );
      ctx.fillText(
        "测试会实际注入鼠标点击。按 Esc 关闭测试画面。",
        w * 0.08,
        h * 0.94,
      );
      for (let i = 0; i < 32; i++) {
        const bit =
          i < 16 ? (0x4e4c >> (15 - i)) & 1 : (clicks >> (31 - i)) & 1;
        ctx.fillStyle = bit ? "#fff" : "#000";
        ctx.fillRect(w * (0.01 + i * 0.008), h * 0.01, w * 0.008, h * 0.02);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") void window.nearlink.invoke("window.hide");
    };
    window.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("mousedown", click);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <>
      <canvas className="benchmark-canvas" ref={ref} />
      <textarea
        aria-label="被控端键盘测试"
        className="benchmark-editor"
        placeholder="可点击此处，测试英文、中文、退格与组合键。"
      />
    </>
  );
}
