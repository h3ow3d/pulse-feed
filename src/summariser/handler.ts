import type { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Allow region override; default to Lambda region
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION;
const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

const RAW_BUCKET = process.env.RAW_BUCKET!;
const SUMMARIES_TABLE = process.env.SUMMARIES_TABLE!;
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-3-haiku-20240307-v1:0';
const SUMMARY_CHAR_LIMIT = Number(process.env.SUMMARY_CHAR_LIMIT ?? '280');
const SKIP_BEDROCK = process.env.SKIP_BEDROCK === 'true';

function parseKey(key: string) {
  // <feed_id>/<post_id>/text.txt
  const parts = key.split('/');
  const post_id = parts.at(-2);
  const feed_id = parts[0];
  return { feed_id, post_id };
}

async function s3GetText(bucket: string, key: string): Promise<string> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await out.Body?.transformToString('utf-8');
  return body ?? '';
}

function buildPrompt(text: string, url?: string) {
  const content = text.slice(0, 12000); // keep prompt bounded
  return `You are a precise summarizer. Summarize the following article in <= ${SUMMARY_CHAR_LIMIT} characters suitable for a tweet.
Return strict JSON: {"summary": string, "hashtags": string[], "tweet": string}
- Prefer concrete facts.
- Avoid emojis, avoid quotes, no line breaks.
- Include 2-4 relevant hashtags (lowercase).
- If a url is provided, append it to tweet at end.

Article:
${content}

${url ? `URL: ${url}` : ''}`;
}

async function bedrockSummarize(text: string, url?: string) {
  const prompt = buildPrompt(text, url);
  const payload = {
    anthropic_version: 'bedrock-2023-05-31', // required by Claude on Bedrock
    max_tokens: 400,
    temperature: 0.2,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(JSON.stringify(payload)),
  }));
  const raw = new TextDecoder().decode(resp.body as Uint8Array);
  const parsed = JSON.parse(raw);
  const textOut: string = parsed?.content?.[0]?.text ?? '';
  let jsonText = textOut.trim();
  const match = jsonText.match(/\{[\s\S]*\}$/);
  if (match) jsonText = match[0];
  try {
    const obj = JSON.parse(jsonText);
    return {
      summary: String(obj.summary ?? '').slice(0, SUMMARY_CHAR_LIMIT),
      hashtags: Array.isArray(obj.hashtags) ? obj.hashtags.map(String).slice(0, 6) : [],
      tweet: String(obj.tweet ?? '').slice(0, 320),
    };
  } catch {
    const trimmed = jsonText.slice(0, SUMMARY_CHAR_LIMIT);
    const tags = ['news'];
    const tweet = url ? `${trimmed} ${url}` : trimmed;
    return { summary: trimmed, hashtags: tags, tweet };
  }
}

export const handler = async (event: S3Event) => {
  for (const rec of event.Records) {
    const bucket = rec.s3.bucket.name;
    const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, ' '));
    if (!key.endsWith('text.txt')) continue;

    const { feed_id, post_id } = parseKey(key);
    if (!post_id) continue;

    const text = await s3GetText(bucket, key);
    if (!text) continue;

    const url = undefined; // could be reconstructed later from metadata
    const { summary, hashtags, tweet } = SKIP_BEDROCK
      ? { summary: text.slice(0, SUMMARY_CHAR_LIMIT), hashtags: ['news'], tweet: text.slice(0, SUMMARY_CHAR_LIMIT) }
      : await bedrockSummarize(text, url);

    const base = key.slice(0, -'text.txt'.length);
    const summaryKey = `${base}summary.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: summaryKey,
      Body: JSON.stringify({ post_id, feed_id, summary, hashtags, tweet }, null, 2),
      ContentType: 'application/json',
    }));

    await ddb.send(new PutCommand({
      TableName: SUMMARIES_TABLE,
      Item: {
        post_id,
        feed_id,
        summary,
        hashtags,
        tweet,
        created_at: new Date().toISOString(),
      },
    }));
  }
  return { ok: true };
};
