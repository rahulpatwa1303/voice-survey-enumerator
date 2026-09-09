// Submit a completed interview to KoboToolbox via the OpenRosa endpoint.
// Verified 2026-09-09: Kobo v1 JSON API is removed, v2 /data/ is read-only.
// The XML root element and its id attribute must be the ASSET UID; version must
// match the served XForm (GET /formList -> downloadUrl -> instance version attr).
import type { Answers } from './form/definition.js';

const KC = process.env.KOBO_KC ?? 'https://kc.kobotoolbox.org';

function xmlEscape(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
}

async function servedVersion(uid: string, token: string): Promise<string> {
  const list = await (await fetch(`${KC}/formList`, {
    headers: { Authorization: `Token ${token}`, 'X-OpenRosa-Version': '1.0' },
  })).text();
  const block = new RegExp(`<xform>(?:(?!</xform>)[\\s\\S])*?<formID>${uid}</formID>[\\s\\S]*?<downloadUrl>(.*?)</downloadUrl>`).exec(list);
  if (!block) throw new Error(`Form ${uid} not in formList (is it deployed?)`);
  const url = block[1].replace(/&amp;/g, '&');
  const xform = await (await fetch(url, { headers: { Authorization: `Token ${token}` } })).text();
  const ver = /<instance>\s*<\w+[^>]*\bversion="([^"]*)"/.exec(xform);
  if (!ver) throw new Error('Could not read version from served XForm');
  return ver[1];
}

export async function submitToKobo(uid: string, answers: Answers): Promise<{ instanceId: string }> {
  const token = process.env.KOBO_TOKEN;
  if (!token) throw new Error('KOBO_TOKEN not set');
  const version = await servedVersion(uid, token);
  const instanceId = `uuid:${crypto.randomUUID()}`;

  const fields = Object.entries(answers)
    .map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`)
    .join('');
  const xml =
    `<?xml version="1.0"?>` +
    `<${uid} id="${uid}" version="${xmlEscape(version)}">` +
    fields +
    `<meta><instanceID>${instanceId}</instanceID></meta>` +
    `</${uid}>`;

  const form = new FormData();
  form.append('xml_submission_file', new Blob([xml], { type: 'text/xml' }), 'submission.xml');
  const res = await fetch(`${KC}/submission`, {
    method: 'POST',
    headers: { Authorization: `Token ${token}`, 'X-OpenRosa-Version': '1.0' },
    body: form,
  });
  if (res.status !== 201) throw new Error(`Kobo submission failed: HTTP ${res.status} ${await res.text()}`);
  return { instanceId };
}
