import sanitizeHtml from 'sanitize-html';

const MAX_HTML_INPUT_CHARS = 1_500_000;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024; // 2 Mo max par image cid inline

const SAFE_INLINE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const SAFE_DATA_IMAGE_URI =
  /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

const SAFE_HTTP_URL = /^https?:\/\/[^\s"'<>]+$/i;
const SAFE_COLOR_VALUE =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/]+\)|[a-z]{3,24})$/i;
const SAFE_LENGTH_VALUE =
  /^(?:0|auto|inherit|initial|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt|cm|mm|ex|ch)?)(?:\s+(?:0|auto|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt)?)){0,3}$/i;
const SAFE_FONT_FAMILY = /^[a-z0-9\s,'"-]{1,120}$/i;
const SAFE_BORDER_VALUE =
  /^(?:none|0|[\d.]+(?:px|pt|em)\s+(?:solid|dashed|dotted|double|none)\s+(?:#[0-9a-f]{3,8}|rgb\([\d,\s]+\)|[a-z]{3,24}))$/i;

const ALLOWED_TAGS: string[] = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

const NON_TEXT_TAGS: string[] = [
  'script',
  'style',
  'textarea',
  'option',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'meta',
  'link',
  'base',
  'svg',
  'math',
  'template',
];

const ALLOWED_ATTRIBUTES: Record<string, sanitizeHtml.AllowedAttribute[]> = {
  '*': ['style', 'dir', 'lang', 'title', 'align', 'valign'],
  a: ['href', 'target', 'rel', 'title'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'data-blocked-src'],
  table: ['width', 'cellpadding', 'cellspacing', 'border', 'bgcolor', 'align'],
  td: ['colspan', 'rowspan', 'width', 'height', 'bgcolor', 'align', 'valign'],
  th: ['colspan', 'rowspan', 'width', 'height', 'bgcolor', 'align', 'valign'],
  tr: ['bgcolor', 'align', 'valign'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
};

const ALLOWED_STYLES: Record<string, Record<string, RegExp[]>> = {
  '*': {
    color: [SAFE_COLOR_VALUE],
    'background-color': [SAFE_COLOR_VALUE],
    'font-family': [SAFE_FONT_FAMILY],
    'font-size': [SAFE_LENGTH_VALUE, /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i],
    'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
    'font-style': [/^(?:normal|italic|oblique)$/i],
    'text-align': [/^(?:left|right|center|justify|start|end)$/i],
    'text-decoration': [/^(?:none|underline|line-through|overline)$/i],
    'line-height': [SAFE_LENGTH_VALUE, /^(?:normal|\d+(?:\.\d+)?)$/i],
    margin: [SAFE_LENGTH_VALUE],
    'margin-top': [SAFE_LENGTH_VALUE],
    'margin-right': [SAFE_LENGTH_VALUE],
    'margin-bottom': [SAFE_LENGTH_VALUE],
    'margin-left': [SAFE_LENGTH_VALUE],
    padding: [SAFE_LENGTH_VALUE],
    'padding-top': [SAFE_LENGTH_VALUE],
    'padding-right': [SAFE_LENGTH_VALUE],
    'padding-bottom': [SAFE_LENGTH_VALUE],
    'padding-left': [SAFE_LENGTH_VALUE],
    border: [SAFE_BORDER_VALUE],
    'border-top': [SAFE_BORDER_VALUE],
    'border-right': [SAFE_BORDER_VALUE],
    'border-bottom': [SAFE_BORDER_VALUE],
    'border-left': [SAFE_BORDER_VALUE],
    'border-color': [SAFE_COLOR_VALUE],
    'border-style': [/^(?:none|solid|dashed|dotted|double)$/i],
    'border-width': [SAFE_LENGTH_VALUE],
    'border-collapse': [/^(?:collapse|separate)$/i],
    'border-radius': [SAFE_LENGTH_VALUE],
    width: [SAFE_LENGTH_VALUE],
    'max-width': [SAFE_LENGTH_VALUE],
    'min-width': [SAFE_LENGTH_VALUE],
    height: [SAFE_LENGTH_VALUE],
    'vertical-align': [/^(?:baseline|top|middle|bottom|text-top|text-bottom|sub|super)$/i],
    display: [/^(?:block|inline|inline-block|table|table-row|table-cell|list-item|none)$/i],
    'white-space': [/^(?:normal|nowrap|pre|pre-wrap|pre-line)$/i],
    'word-break': [/^(?:normal|break-word|break-all|keep-all)$/i],
    'list-style-type': [/^(?:none|disc|circle|square|decimal|lower-alpha|upper-alpha)$/i],
  },
};

export interface InlineCidResource {
  contentType: string;
  content: Buffer;
}

export interface SanitizeEmailHtmlOptions {
  allowRemoteImages?: boolean;
  inlineCidMap?: Map<string, InlineCidResource>;
}

export interface SanitizedEmailHtmlResult {
  html: string;
  hasBlockedRemoteImages: boolean;
  blockedRemoteImagesCount: number;
}

function normalizeCidKey(rawCid: string): string {
  return rawCid.trim().replace(/^<|>$/g, '').toLowerCase();
}

function stripControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0x1f && code !== 0x7f) {
      out += value[i];
    }
  }
  return out;
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function plainTextToSafeHtml(rawText: string): string {
  const safeInput = typeof rawText === 'string' ? rawText.slice(0, MAX_HTML_INPUT_CHARS) : '';
  const escaped = escapeHtmlText(safeInput);
  const withLinks = escaped.replace(
    /(https?:\/\/[^\s<>"'()[\]{}]+)/gi,
    (match) =>
      `<a href="${match}" target="_blank" rel="noopener noreferrer nofollow">${match}</a>`
  );
  return `<div style="white-space: pre-wrap; word-break: break-word;">${withLinks}</div>`;
}

export function sanitizeEmailHtml(
  rawHtml: string,
  options: SanitizeEmailHtmlOptions = {}
): SanitizedEmailHtmlResult {
  const input = typeof rawHtml === 'string' ? rawHtml.slice(0, MAX_HTML_INPUT_CHARS) : '';
  if (!input.trim()) {
    return {
      html: '',
      hasBlockedRemoteImages: false,
      blockedRemoteImagesCount: 0,
    };
  }

  const allowRemoteImages = Boolean(options.allowRemoteImages);
  const inlineCidMap = options.inlineCidMap;
  let blockedRemoteImagesCount = 0;

  const cleaned = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    nonTextTags: NON_TEXT_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: {
      a: ['http', 'https', 'mailto', 'tel'],
      img: ['http', 'https', 'data'],
    },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: false,
    parseStyleAttributes: true,
    nestingLimit: 50,
    transformTags: {
      a: (tagName, attribs) => {
        const nextAttribs: sanitizeHtml.Attributes = {};
        if (typeof attribs['title'] === 'string' && attribs['title'].trim()) {
          nextAttribs['title'] = attribs['title'].trim().slice(0, 200);
        }
        const rawHref = typeof attribs['href'] === 'string' ? attribs['href'].trim() : '';
        const cleanedHref = stripControlChars(rawHref);
        if (/^(?:https?:\/\/|mailto:|tel:)/i.test(cleanedHref)) {
          nextAttribs['href'] = cleanedHref;
          nextAttribs['target'] = '_blank';
          nextAttribs['rel'] = 'noopener noreferrer nofollow';
        }
        return { tagName, attribs: nextAttribs };
      },
      img: (tagName, attribs) => {
        const nextAttribs: sanitizeHtml.Attributes = {};
        if (typeof attribs['alt'] === 'string') {
          nextAttribs['alt'] = attribs['alt'].slice(0, 200);
        }
        if (typeof attribs['width'] === 'string' && /^\d{1,4}$/.test(attribs['width'].trim())) {
          nextAttribs['width'] = attribs['width'].trim();
        }
        if (typeof attribs['height'] === 'string' && /^\d{1,4}$/.test(attribs['height'].trim())) {
          nextAttribs['height'] = attribs['height'].trim();
        }

        const rawSrc = typeof attribs['src'] === 'string' ? attribs['src'].trim() : '';
        const normalizedSrc = stripControlChars(rawSrc);

        // 1. Images inline CID (pièces jointes embarquées de l'email)
        if (/^cid:/i.test(normalizedSrc)) {
          const cidKey = normalizeCidKey(normalizedSrc.slice(4));
          const inlineAsset = inlineCidMap?.get(cidKey);
          const mime = inlineAsset?.contentType.toLowerCase().split(';')[0].trim() ?? '';
          if (
            inlineAsset &&
            SAFE_INLINE_IMAGE_MIMES.has(mime) &&
            inlineAsset.content.length > 0 &&
            inlineAsset.content.length <= MAX_INLINE_IMAGE_BYTES
          ) {
            nextAttribs['src'] = `data:${mime};base64,${inlineAsset.content.toString('base64')}`;
          }
          return { tagName, attribs: nextAttribs };
        }

        // 2. Images data: raster sûres uniquement (jamais SVG / HTML)
        if (/^data:/i.test(normalizedSrc)) {
          if (SAFE_DATA_IMAGE_URI.test(normalizedSrc) && normalizedSrc.length <= MAX_INLINE_IMAGE_BYTES * 1.4) {
            nextAttribs['src'] = normalizedSrc;
          }
          return { tagName, attribs: nextAttribs };
        }

        // 3. Images distantes http(s) : bloquées par défaut (anti-pixel espion / anti-fuite IP)
        if (SAFE_HTTP_URL.test(normalizedSrc)) {
          if (allowRemoteImages) {
            nextAttribs['src'] = normalizedSrc;
            nextAttribs['loading'] = 'lazy';
          } else {
            blockedRemoteImagesCount += 1;
            nextAttribs['data-blocked-src'] = '1';
            if (!nextAttribs['alt']) {
              nextAttribs['alt'] = 'Image externe bloquée';
            }
          }
          return { tagName, attribs: nextAttribs };
        }

        // Tout autre schéma (javascript:, file:, vbscript:, etc.) : src supprimé
        return { tagName, attribs: nextAttribs };
      },
    },
  });

  return {
    html: cleaned,
    hasBlockedRemoteImages: blockedRemoteImagesCount > 0,
    blockedRemoteImagesCount,
  };
}
