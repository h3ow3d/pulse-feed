import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * Hoisted helpers used inside mocks (Vitest hoists vi.mock, so define these first)
 */
const h = vi.hoisted(() => {
  return {
    ssmSend: vi.fn(async () => ({
      Parameter: { Value: JSON.stringify(['https://example.com/feed.xml']) },
    })),
    ddbSend: vi.fn(async () => ({})),
    putInputs: [] as any[], // capture PutCommand inputs here for assertions
  };
});

/**
 * Mocks (these calls are hoisted by Vitest)
 */
vi.mock('@aws-sdk/client-ssm', () => {
  class GetParameterCommand { constructor(public input: any) {} }
  class SSMClient { send = h.ssmSend; }
  return { SSMClient, GetParameterCommand };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {}
  return { DynamoDBClient };
});

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class PutCommand {
    input: any;
    constructor(input: any) {
      this.input = input;
      h.putInputs.push(input); // record constructor input
    }
  }
  const DynamoDBDocumentClient = {
    from: () => ({ send: h.ddbSend }),
  };
  return { DynamoDBDocumentClient, PutCommand };
});

vi.mock('rss-parser', () => {
  class Parser {
    async parseString(_text: string) {
      return {
        items: [
          { title: 'One', link: 'https://ex/a', pubDate: '2025-09-14T00:00:00Z', contentSnippet: 'a' },
          { title: 'Two', link: 'https://ex/b', pubDate: '2025-09-14T00:00:00Z', contentSnippet: 'b' },
        ],
      };
    }
  }
  return { default: Parser };
});

vi.mock('undici', () => ({
  fetch: vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode('<rss/>'),
  })),
}));

/**
 * Set env BEFORE importing the SUT, then import in beforeAll()
 */
process.env.AWS_REGION  = 'eu-west-2';
process.env.POSTS_TABLE = 'PulseFeedPosts';
process.env.FEEDS_PARAM = '/pulse-feed/feeds';

let handler: (event?: any) => Promise<any>;

beforeAll(async () => {
  vi.resetModules(); // ensure a clean module graph so env is read now
  ({ handler } = await import('../../src/ingest/handler'));
});

describe('ingest.handler (component-ish)', () => {
  beforeEach(() => {
    h.ddbSend.mockClear();
    h.ssmSend.mockClear();
    h.putInputs.length = 0;
  });

  it('loads feeds, parses items, writes to DDB with idempotency', async () => {
    const res = await handler();
    expect(res.feedsProcessed).toBe(1);

    // Two RSS items => two PutItem attempts
    expect(h.ddbSend).toHaveBeenCalledTimes(2);
    expect(h.putInputs.length).toBe(2);

    // Validate PutCommand inputs captured at construction time
    for (const input of h.putInputs) {
      expect(input.TableName).toBe(process.env.POSTS_TABLE);
      expect(String(input.ConditionExpression)).toContain('attribute_not_exists');
      expect(input.Item.feed_id).toBeTruthy();
      expect(input.Item.post_id).toBeTruthy();
      expect(input.Item.link).toBeTruthy();
    }
  });
});
