import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// mock undici fetch
vi.mock('undici', () => ({
  fetch: vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode('<html><body><h1>Hi</h1></body></html>'),
  })),
}));

const s3Mock = mockClient(S3Client);

process.env.RAW_BUCKET = 'test-bucket';
process.env.MAX_BYTES = '4000000';

import { handler } from '../../src/fetcher/handler';

describe('fetcher', () => {
  beforeEach(() => s3Mock.reset());

  it('writes raw.html and text.txt to S3', async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const msgBody = {
      eventName: 'INSERT',
      dynamodb: {
        NewImage: {
          feed_id: { S: 'news.ycombinator.com' },
          post_id: { S: 'abc123' },
          link:    { S: 'https://example.com/article' },
        },
      },
    };

    const event = {
      Records: [
        {
          body: JSON.stringify(msgBody),
        },
      ],
    } as any;

    const res = await handler(event);
    expect(res).toEqual({ ok: true, count: 1 });

    const keys = s3Mock.commandCalls(PutObjectCommand).map(c => c.args[0].input.Key);
    expect(keys).toContain('news.ycombinator.com/abc123/raw.html');
    expect(keys).toContain('news.ycombinator.com/abc123/text.txt');
  });
});
