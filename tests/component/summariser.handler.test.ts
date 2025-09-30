import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

// env BEFORE import
process.env.RAW_BUCKET = 'bucket';
process.env.SUMMARIES_TABLE = 'PulseFeedSummaries';
process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';
process.env.BEDROCK_REGION = 'eu-west-2';
process.env.SUMMARY_CHAR_LIMIT = '280';

const s3Mock = mockClient(S3Client);
const brMock = mockClient(BedrockRuntimeClient);

// Mock lib-dynamodb to avoid real AWS
const h = vi.hoisted(() => ({
  ddbSend: vi.fn(async () => ({})),
  putInputs: [] as any[],
}));
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class PutCommand {
    input: any;
    constructor(input: any) {
      this.input = input;
      h.putInputs.push(input);
    }
  }
  const DynamoDBDocumentClient = {
    from: () => ({ send: h.ddbSend }),
  };
  return { DynamoDBDocumentClient, PutCommand };
});

let handler: (e: any) => Promise<any>;
beforeAll(async () => {
  vi.resetModules();
  ({ handler } = await import('../../src/summariser/handler'));
});

describe('summariser.handler', () => {
  beforeEach(() => {
    s3Mock.reset();
    brMock.reset();
    h.ddbSend.mockClear();
    h.putInputs.length = 0;
  });

  it('reads text.txt, calls Bedrock, writes summary.json and DDB item', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToString: async () => 'Short article about AWS cloud and Bedrock.' } as any,
    });

    const bedrockBody = {
      content: [{
        text: JSON.stringify({
          summary: 'Short AWS cloud summary.',
          hashtags: ['aws', 'cloud'],
          tweet: 'Short AWS cloud summary. #aws #cloud'
        }),
      }],
    };
    brMock.on(InvokeModelCommand).resolves({
      body: new TextEncoder().encode(JSON.stringify(bedrockBody)),
    } as any);

    s3Mock.on(PutObjectCommand).resolves({});

    const evt = {
      Records: [
        { s3: { bucket: { name: 'bucket' }, object: { key: 'news.ycombinator.com/abc123/text.txt' } } },
      ],
    } as any;

    const res = await handler(evt);
    expect(res).toEqual({ ok: true });

    const putKeys = s3Mock.commandCalls(PutObjectCommand).map(c => (c.args[0].input as any).Key);
    expect(putKeys).toContain('news.ycombinator.com/abc123/summary.json');

    expect(h.ddbSend).toHaveBeenCalledTimes(1);
    expect(h.putInputs[0].TableName).toBe(process.env.SUMMARIES_TABLE);
  });
});
