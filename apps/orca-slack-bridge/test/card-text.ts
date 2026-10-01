/**
 * 카드에서 사람이 보는 문자열을 꺼내는 test helper.
 *
 * 카드 본문은 attachment 안에 있고 칸은 section `fields`에 있다(`slack/card.ts`). 최상위 `blocks`의
 * section text만 읽는 helper는 본문을 하나도 보지 못하고, 그러면 "없다" 단언이 공허하게 통과한다.
 */

type Block = Readonly<Record<string, unknown>>;

export type CardLike = {
  readonly text: string;
  readonly blocks: readonly Block[];
  readonly attachments?: readonly { readonly color?: string; readonly blocks: readonly Block[] }[];
};

/** 최상위 block과 attachment block 전부. 머리·버튼이 앞이고 본문이 뒤다. */
export function allBlocks(card: CardLike): readonly Block[] {
  return [...card.blocks, ...(card.attachments ?? []).flatMap((attachment) => attachment.blocks)];
}

function textOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const text = (value as { readonly text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

/** block 하나에서 사람이 보는 문자열. 버튼은 label만 보고 action_id·value·url은 보지 않는다. */
function blockTexts(block: Block): string[] {
  const out: string[] = [];
  const direct = textOf(block['text']);
  if (direct !== null) out.push(direct);
  for (const key of ['fields', 'elements'] as const) {
    const items = block[key];
    if (!Array.isArray(items)) continue;
    for (const item of items as readonly unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Readonly<Record<string, unknown>>;
      // context element와 field는 `text`가 문자열이고, 버튼은 `text.text`가 label이다.
      if (typeof record['text'] === 'string') out.push(record['text']);
      else {
        const label = textOf(record['text']);
        if (label !== null) out.push(label);
      }
    }
  }
  return out;
}

/** 사람이 보는 문자열 전부: 대체 텍스트, 머리, 칸, section, footer, 버튼 label. */
export function visibleTexts(card: CardLike): readonly string[] {
  return [card.text, ...allBlocks(card).flatMap(blockTexts)];
}

/** 카드에 보이는 문자열을 한 줄씩 잇는다. 포함·불포함 단언에 쓴다. */
export function cardText(card: CardLike): string {
  return visibleTexts(card).join('\n');
}

/** 머리 한 줄. */
export function headerText(card: CardLike): string {
  const header = card.blocks.find((block) => block['type'] === 'header');
  return textOf(header?.['text']) ?? '';
}

/** `*label*\nvalue` 칸의 값. 그런 칸이 없으면 undefined. */
export function fieldValue(card: CardLike, label: string): string | undefined {
  const prefix = `*${label}*\n`;
  for (const block of allBlocks(card)) {
    const fields = block['fields'];
    if (!Array.isArray(fields)) continue;
    for (const field of fields as readonly unknown[]) {
      const text = textOf(field);
      if (text !== null && text.startsWith(prefix)) return text.slice(prefix.length);
    }
  }
  return undefined;
}

/** footer(context) 한 줄. */
export function footerText(card: CardLike): string {
  const context = allBlocks(card).find((block) => block['type'] === 'context');
  const elements = context?.['elements'];
  return Array.isArray(elements) ? (textOf(elements[0]) ?? '') : '';
}

/** attachment section text(설명 문장과 목록). 칸은 빠진다. */
export function sectionTexts(card: CardLike): readonly string[] {
  return (card.attachments ?? [])
    .flatMap((attachment) => attachment.blocks)
    .map((block) => (block['type'] === 'section' ? textOf(block['text']) : null))
    .filter((text): text is string => text !== null);
}

const COLOR_NAME: Readonly<Record<string, string>> = {
  '#2f81f7': 'blue',
  '#1a7f37': 'green',
  '#cf222e': 'red',
  '#bf8700': 'amber',
  '#8250df': 'purple',
  '#6e7781': 'gray',
};

/**
 * 사람이 읽는 미리보기. `┃`는 색 바 안이다. 문서 예시와 스냅샷이 이 모양을 쓴다.
 *
 * ```text
 * {header}
 * [버튼] [버튼 · primary]
 * ┃green
 * ┃ 라벨  값
 * ┃ ───
 * ┃ orca-slack-bridge · …
 * ```
 */
export function preview(card: CardLike): string {
  const lines: string[] = [];
  for (const block of card.blocks) {
    if (block['type'] === 'header') lines.push(textOf(block['text']) ?? '');
    if (block['type'] === 'actions') {
      const elements = (block['elements'] ?? []) as readonly Readonly<Record<string, unknown>>[];
      lines.push(elements
        .map((e) => `[${textOf(e['text']) ?? ''}${e['style'] === 'primary' ? ' · primary' : ''}]`)
        .join(' '));
    }
  }
  for (const attachment of card.attachments ?? []) {
    lines.push(`┃${COLOR_NAME[attachment.color ?? ''] ?? attachment.color ?? ''}`);
    for (const block of attachment.blocks) {
      if (block['type'] === 'divider') {
        lines.push('┃ ───');
        continue;
      }
      for (const text of blockTexts(block)) {
        const field = /^\*([^*\n]+)\*\n([\s\S]*)$/.exec(text);
        if (block['fields'] !== undefined && field !== null) {
          const [, label = '', value = ''] = field;
          const [first = '', ...rest] = value.split('\n');
          lines.push(`┃ ${label}  ${first}`);
          for (const line of rest) lines.push(`┃ ${' '.repeat(label.length + 2)}${line}`);
          continue;
        }
        for (const line of text.split('\n')) lines.push(`┃ ${line}`);
      }
    }
  }
  return lines.join('\n');
}
