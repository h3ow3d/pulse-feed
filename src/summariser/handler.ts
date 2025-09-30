import { S3Event, S3EventRecord } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const required = (k: string) => {
  const v = process.env[k];
  if (!v || !String(v).trim()) throw new Error(`Missing required env var: ${k}`);
  return v;
};

const RAW_BUCKET = required('RAW_BUCKET');
const SUMMARIES_TABLE = required('SUMMARIES_TABLE');
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-3-haiku-20240307-v1:0';
const SUMMARY_CHAR_LIMIT = Number(process.env.SUMMARY_CHAR_LIMIT ?? '280');
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'eu-west-2';
const SKIP_BEDROCK = process.env.SKIP_BEDROCK === 'true';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

// helpers
const streamToString = async (body: any): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    body.on('data', (c: Buffer) => chunks.push(c));
    body.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    body.on('error', reject);
  });

function parseKey(rec: S3EventRecord) {
  const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, ' '));
  // expect: <feed_id>/<post_id>/text.txt
  const parts = key.split('/');
  if (parts.length < 3) throw new Error(`Unexpected key layout: ${key}`);
  const feed_id = parts[0];
  const post_id = parts[1];
  const prefix = `${feed_id}/${post_id}`;
  return { key, feed_id, post_id, prefix };
}

async function summariseWithBedrock(text: string) {
  const system = `You are a concise assistant. Summarize the article into <= ${SUMMARY_CHAR_LIMIT} characters, include 2–3 relevant hashtags, and produce a tweet-length variant. Respond ONLY as compact JSON:

{"summary":"...","hashtags":["#...","#..."],"tweet":"..."}`;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 512,
    temperature: 0.2,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `${system}\n\nArticle:\n${text}` }] },
    ],
  };

  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    }),
  );

  const bodyStr = new TextDecoder().decode(res.body as any);
  const body = JSON.parse(bodyStr);
  const assistantText: string =
    body?.content?.[0]?.text ??
    body?.output_text ??
    '';

  let parsed: { summary: string; hashtags: string[]; tweet: string };
  try {
    parsed = JSON.parse(assistantText);
    if (!parsed.summary) throw new Error('missing summary');
  } catch {
    const fallback = assistantText.slice(0, SUMMARY_CHAR_LIMIT);
    parsed = { summary: fallback, hashtags: [], tweet: fallback };
  }
  // Clamp lengths
  parsed.summary = parsed.summary.slice(0, SUMMARY_CHAR_LIMIT);
  parsed.tweet = parsed.tweet.slice(0, SUMMARY_CHAR_LIMIT);
  return parsed;
}

export const handler = async (event: S3Event) => {
  // grab first record (bucket events come one-by-one for our use)
  const rec = event.Records[0];
  const { feed_id, post_id, prefix } = parseKey(rec);

  // read text.txt
  const textObj = await s3.send(
    new GetObjectCommand({ Bucket: RAW_BUCKET, Key: `${prefix}/text.txt` }),
  );
  const text = await streamToString(textObj.Body as any);

  // summarise
  let result: { summary: string; hashtags: string[]; tweet: string };
  if (SKIP_BEDROCK) {
    const fallback = text.slice(0, SUMMARY_CHAR_LIMIT);
    result = { summary: fallback, hashtags: ['#news'], tweet: fallback };
  } else {
    result = await summariseWithBedrock(text);
  }

  // write summary.json
  await s3.send(
    new PutObjectCommand({
      Bucket: RAW_BUCKET,
      Key: `${prefix}/summary.json`,
      Body: JSON.stringify(result),
      ContentType: 'application/json',
    }),
  );

  // upsert to DDB
  await ddb.send(
    new PutCommand({
      TableName: SUMMARIES_TABLE,
      Item: {
        post_id,
        feed_id,
        summary: result.summary,
        hashtags: result.hashtags,
        tweet: result.tweet,
        created_at: new Date().toISOString(),
      },
    }),
  );

  return { ok: true, post_id, feed_id };
};
