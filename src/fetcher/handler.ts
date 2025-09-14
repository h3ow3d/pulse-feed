import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { fetch } from 'undici';

const s3 = new S3Client({});
const BUCKET = process.env.RAW_BUCKET!;
const MAX_BYTES = Number(process.env.MAX_BYTES ?? '4000000');

type DdbStr = { S?: string; NULL?: boolean };
type DdbImage = Record<string, DdbStr>;
type DdbStreamRecord = {
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE';
  dynamodb: { NewImage?: DdbImage };
};

function getString(img: DdbImage, key: string): string | undefined {
  const v = img[key];
  return v?.S;
}

async function processRecord(rec: SQSRecord) {
  const body = JSON.parse(rec.body) as DdbStreamRecord;
  if (body.eventName !== 'INSERT' || !body.dynamodb.NewImage) return;

  const img = body.dynamodb.NewImage;
  const feedId = getString(img, 'feed_id') ?? 'unknown';
  const postId = getString(img, 'post_id') ?? 'unknown';
  const link   = getString(img, 'link');
  if (!link) return;

  // Fetch HTML (basic guardrails)
  const res = await fetch(link, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${link}`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) throw new Error(`Too large: ${ab.byteLength}`);

  const html = Buffer.from(ab).toString('utf8');

  // quick & dirty text extraction
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const prefix = `${feedId}/${postId}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${prefix}/raw.html`,
    Body: html,
    ContentType: 'text/html; charset=utf-8',
  }));
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${prefix}/text.txt`,
    Body: text,
    ContentType: 'text/plain; charset=utf-8',
  }));
}

export const handler = async (event: SQSEvent) => {
  // process sequentially to keep it simple; SQS + Lambda will parallelize
  for (const rec of event.Records) {
    await processRecord(rec);
  }
  return { ok: true, count: event.Records.length };
};
