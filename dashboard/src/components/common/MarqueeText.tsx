import { useEffect, useRef, useState, type CSSProperties } from "react";

/** Owner request: long names (conversation, project, sidebar rows) that get
 * clipped by their container should MARQUEE — but only while HOVERED, never
 * running permanently. Measures the inner text against the wrapper; when it
 * truly overflows the wrapper gets the `over` class and the CSS plays the
 * sway animation on :hover (duration scales with the overflow width).
 * prefers-reduced-motion keeps the text clipped and still — every caller
 * carries the full name in a title tooltip for hover/AT users. */
export function MarqueeText({ text }: { text: string }) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;
    const measure = () => {
      const overflow = inner.offsetWidth - wrap.clientWidth;
      setShift(overflow > 2 ? overflow : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    window.addEventListener("resize", measure);
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [text]);

  const dur = shift > 0 ? Math.max(3.5, Math.round((shift / 22) * 10) / 10) : 0;
  return (
    <span ref={wrapRef} className={`marquee${shift > 0 ? " over" : ""}`}>
      <span
        ref={innerRef}
        className="marquee-inner"
        style={
          shift > 0
            ? ({ "--marquee-shift": `-${shift}px`, "--marquee-dur": `${dur}s` } as CSSProperties)
            : undefined
        }
      >
        {text}
      </span>
    </span>
  );
}
