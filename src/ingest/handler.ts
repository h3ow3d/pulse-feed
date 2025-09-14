import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import Parser from 'rss-parser';
import pMap from 'p-map';
import { fetch } from 'undici';
import crypto from 'node:crypto';

const REGION = process.env.AWS_REGION || 'eu-west-2';
const POSTS_TABLE = process.env.POSTS_TABLE!;
const FEEDS_PARAM = process.env.FEEDS_PARAM!;

const ssm = new SSMClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true }
});

const parser = new Parser({
  requestOptions: { timeout: 10000, headers: { 'user-agent': 'pulse-feed/1.0' } },
  customFields: { item: [['content:encoded', 'contentEncoded']] }
});

export function makePostId(link?: string, guid?: string, pubDate?: string) {
  const base = link || guid || pubDate || crypto.randomUUID();
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 24);
}

async function loadFeedList(): Promise<string[]> {
  const resp = await ssm.send(new GetParameterCommand({ Name: FEEDS_PARAM }));
  if (!resp.Parameter?.Value) return [];
  return JSON.parse(resp.Parameter.Value);
}

async function putPost(feedId: string, item: any) {
  const post_id = makePostId(item.link, item.guid, item.isoDate ?? item.pubDate);
  const record = {
    feed_id: feedId,
    post_id,
    title: item.title?.toString().slice(0, 512),
    link: item.link,
    published_at: item.isoDate ?? item.pubDate ?? null,
    summary_from_feed: item.contentSnippet ?? null,
    fetched_at: new Date().toISOString(),
    source: item?.creator ?? null,
  };

  try {
    await ddb.send(new PutCommand({
      TableName: POSTS_TABLE,
      Item: record,
      ConditionExpression: 'attribute_not_exists(post_id)',
    }));
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      // duplicate – safe to ignore
      return;
    }
    throw err;
  }
}

async function fetchAndParse(url: string) {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`Feed HTTP ${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 5_000_000) throw new Error('Feed too large');
  const text = Buffer.from(buf).toString('utf8');
  return parser.parseString(text);
}

export async function handler() {
  const feeds = await loadFeedList();
  if (feeds.length === 0) return { feedsProcessed: 0, itemsNew: 0 };

  let itemsNew = 0;

  await pMap(
    feeds,
    async (feedUrl) => {
      const feed = await fetchAndParse(feedUrl);
      const feedId = new URL(feedUrl).hostname;
      const items = feed.items ?? [];
      await pMap(
        items,
        async (item) => {
          const before = itemsNew;
          await putPost(feedId, item);
          if (before === itemsNew) itemsNew += 1; // best-effort count
        },
        { concurrency: 5 }
      );
    },
    { concurrency: 3 }
  );

  return { feedsProcessed: feeds.length, itemsNew };
}
