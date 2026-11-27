import { useState, type ReactNode } from "react";
import { useLang } from "../../lib/i18n";
import { CheckIcon, CopyIcon } from "../common/Icons";
import { copyText } from "../common/ui";

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "quote"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "hr" }
  | { type: "para"; lines: string[] };

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parses inline markdown tokens safely into React nodes (never uses dangerouslySetInnerHTML).
 * Supports `code`, **bold**, *italic* / _italic_, [label](url), and bare https:// links.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: inline code first, then markdown links, bold, italic, bare URLs
  const tokenRe =
    /(`[^`\n]+`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(https?:\/\/[^\s<>"')\]]+)/g;

  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(text.slice(lastIdx, match.index));
    }
    const key = `${keyPrefix}-${idx++}`;
    if (match[1]) {
      // Inline code
      nodes.push(
        <code key={key} className="md-inline-code">
          {match[1].slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      // [label](url)
      const label = match[3];
      const href = match[4];
      if (isSafeHttpUrl(href)) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="md-link">
            {label}
          </a>,
        );
      } else {
        nodes.push(match[0]);
      }
    } else if (match[5]) {
      // **bold**
      nodes.push(<strong key={key}>{renderInline(match[6], `${key}b`)}</strong>);
    } else if (match[7]) {
      // *italic*
      nodes.push(<em key={key}>{renderInline(match[8], `${key}i`)}</em>);
    } else if (match[9]) {
      // _italic_
      nodes.push(<em key={key}>{renderInline(match[10], `${key}u`)}</em>);
    } else if (match[11]) {
      // bare http(s) URL
      const href = match[11];
      if (isSafeHttpUrl(href)) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="md-link">
            {href}
          </a>,
        );
      } else {
        nodes.push(href);
      }
    }
    lastIdx = tokenRe.lastIndex;
  }

  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }

  return nodes;
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Fenced code block ```lang
    const fence = line.match(/^```([A-Za-z0-9_+.-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || "text";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Headings (#, ##, ###)
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: heading[2].trim() });
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", lines: quoteLines });
      continue;
    }

    // Unordered list
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Paragraph (stop when encountering blank line or block starter)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "para", lines: paraLines });
    }
  }

  return blocks;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useLang();

  async function handleCopy() {
    await copyText(code, t("md.copiedCode"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="md-codeblock">
      <div className="md-code-head">
        <span className="md-code-lang">{lang}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={handleCopy}
          title={t("md.copyCodeAria")}
          aria-label={t("md.copyCodeAria")}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          <span>{copied ? t("common.copied") : t("common.copy")}</span>
        </button>
      </div>
      <pre className="md-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderLinesWithBreaks(lines: string[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`${keyPrefix}-br-${idx}`} />);
    out.push(...renderInline(line, `${keyPrefix}-l${idx}`));
  });
  return out;
}

export function MarkdownBody({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);

  return (
    <div className={`body md-body${className ? ` ${className}` : ""}`}>
      {blocks.map((b, idx) => {
        const k = `b${idx}`;
        switch (b.type) {
          case "code":
            return <CodeBlock key={k} lang={b.lang} code={b.code} />;
          case "hr":
            return <hr key={k} className="md-hr" />;
          case "heading": {
            const Tag = b.level === 1 ? "h3" : b.level === 2 ? "h4" : "h5";
            return (
              <Tag key={k} className={`md-h md-h${b.level}`}>
                {renderInline(b.text, k)}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote key={k} className="md-quote">
                {renderLinesWithBreaks(b.lines, k)}
              </blockquote>
            );
          case "ul":
            return (
              <ul key={k} className="md-list">
                {b.items.map((item, ii) => (
                  <li key={`${k}-${ii}`}>{renderInline(item, `${k}-${ii}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={k} className="md-list">
                {b.items.map((item, ii) => (
                  <li key={`${k}-${ii}`}>{renderInline(item, `${k}-${ii}`)}</li>
                ))}
              </ol>
            );
          case "para":
            return (
              <p key={k} className="md-p">
                {renderLinesWithBreaks(b.lines, k)}
              </p>
            );
        }
      })}
    </div>
  );
}
