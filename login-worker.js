import { parentPort, workerData } from 'node:worker_threads';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';

// Public NTQQ issue reports establish this URL family, not current-client live verification:
// https://github.com/NapNeko/NapCatQQ/issues/1245 (also /1656, /1804, /432).
// Never post decoded data or decoder errors to the Host.
function supported(payload) {
  if (typeof payload !== 'string' || payload.length > 2048 || !/^https:\/\/txz\.qq\.com\/p\?/.test(payload) || /[\s\x00-\x1f\x7f]/.test(payload)) return false;
  let url; try { url = new URL(payload); } catch { return false; }
  if (url.protocol !== 'https:' || url.hostname !== 'txz.qq.com' || url.pathname !== '/p' || url.username || url.password || url.port || url.hash) return false;
  const keys = [...url.searchParams.keys()];
  if (!keys.includes('k') || keys.some(key => !['k', 'f'].includes(key)) || new Set(keys).size !== keys.length) return false;
  const k = url.searchParams.get('k'), f = url.searchParams.get('f');
  if (!k || k.length > 1024 || (f !== null && (!f || f.length > 512))) return false;
  // Opaque fields are not interpreted, but controls/whitespace are never valid credentials here.
  return ![k, f ?? ''].some(value => /[\s\x00-\x1f\x7f]/.test(value));
}

try {
  const png = Buffer.from(workerData);
  // Defense in depth: reject the pngjs interlaced inflate path and unexpected bit depths.
  if (png.length < 33 || png.length > 8 * 1024 * 1024 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR' || png[24] !== 8 || ![2, 6].includes(png[25]) || png[26] || png[27] || png[28]) throw new Error('format');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width < 240 || height < 240 || width > 2048 || height > 2048) throw new Error('size');
  let offset = 8, headers = 0, hasData = false, ended = false;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error('chunks');
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    if (size > png.length - offset - 12) throw new Error('chunks');
    if (type === 'IHDR' && (++headers !== 1 || offset !== 8 || size !== 13)) throw new Error('chunks');
    if (type === 'IDAT') hasData = true;
    offset += size + 12;
    if (type === 'IEND') { if (size !== 0 || offset !== png.length) throw new Error('chunks'); ended = true; break; }
  }
  if (headers !== 1 || !hasData || !ended) throw new Error('chunks');
  const image = PNG.sync.read(png, { checkCRC: true });
  const code = jsQR(new Uint8ClampedArray(image.data), image.width, image.height, { inversionAttempts: 'attemptBoth' });
  if (!code) parentPort.postMessage({ ok: false, reason: 'missing' });
  else if (!supported(code.data)) parentPort.postMessage({ ok: false, reason: 'unsupported' });
  else {
    const image = await QRCode.toDataURL(code.data, { type: 'image/png', width: 320, margin: 4, errorCorrectionLevel: 'M' });
    parentPort.postMessage({ ok: true, image });
  }
} catch { parentPort.postMessage({ ok: false, reason: 'unsupported' }); }
