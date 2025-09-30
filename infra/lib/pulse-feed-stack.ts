import * as path from 'path';
import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { Table, AttributeType, BillingMode, StreamViewType } from 'aws-cdk-lib/aws-dynamodb';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Queue, DeadLetterQueue } from 'aws-cdk-lib/aws-sqs';
import { Role, ServicePrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CfnPipe } from 'aws-cdk-lib/aws-pipes';

import { Bucket, BlockPublicAccess, EventType } from 'aws-cdk-lib/aws-s3';
import { SqsEventSource, S3EventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

export class PulseFeedStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // DynamoDB: posts (stream enabled)
    const posts = new Table(this, 'PulseFeedPosts', {
      partitionKey: { name: 'feed_id', type: AttributeType.STRING },
      sortKey: { name: 'post_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.DESTROY, // DEV ONLY - remove in prod
    });

    // SSM: feeds param
    const feedsParam = new StringParameter(this, 'PulseFeedFeedsParam', {
      parameterName: '/pulse-feed/feeds',
      stringValue: JSON.stringify([
        'https://aws.amazon.com/blogs/aws/feed/',
        'https://news.ycombinator.com/rss',
      ]),
    });

    // Lambda: ingest (EventBridge scheduled)
    const ingest = new NodejsFunction(this, 'PulseFeedIngest', {
      functionName: 'PulseFeedIngest',
      entry: path.join(__dirname, '../../src/ingest/handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.seconds(30),
      tracing: Tracing.ACTIVE,
      bundling: { minify: true, sourcesContent: false },
      environment: {
        POSTS_TABLE: posts.tableName,
        FEEDS_PARAM: feedsParam.parameterName,
      },
    });
    posts.grantReadWriteData(ingest);
    feedsParam.grantRead(ingest);

    new Rule(this, 'PulseFeedIngestSchedule', {
      schedule: Schedule.rate(Duration.minutes(15)),
      targets: [new LambdaFunction(ingest)],
    });

    // SQS + DLQ for fetch pipeline
    const toFetchDlq = new Queue(this, 'PulseFeedToFetchDLQ', {
      retentionPeriod: Duration.days(14),
    });
    const toFetch = new Queue(this, 'PulseFeedToFetch', {
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: { maxReceiveCount: 5, queue: toFetchDlq } as DeadLetterQueue,
    });

    // Pipes: DDB stream (INSERT) -> SQS
    const pipeRole = new Role(this, 'PulseFeedPipeRole', {
      assumedBy: new ServicePrincipal('pipes.amazonaws.com'),
    });
    pipeRole.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'],
      resources: ['*'], // scope to posts.tableStreamArn if you want to tighten
    }));
    pipeRole.addToPolicy(new PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [toFetch.queueArn],
    }));

    new CfnPipe(this, 'PulseFeedDdbToSqsPipe', {
      roleArn: pipeRole.roleArn,
      source: posts.tableStreamArn!,
      target: toFetch.queueArn,
      sourceParameters: {
        filterCriteria: {
          filters: [{ pattern: '{"eventName":["INSERT"]}' }],
        },
        dynamoDbStreamParameters: {
          startingPosition: 'LATEST',
          batchSize: 10,
        },
      },
      targetParameters: {
        sqsQueueParameters: {},
      },
    });

    // S3 bucket for raw content
    const rawBucket = new Bucket(this, 'PulseFeedRawContent', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY, // DEV ONLY - remove in prod
      autoDeleteObjects: true,              // DEV ONLY - remove in prod
    });

    // Lambda: fetcher (SQS -> fetch -> S3)
    const fetcher = new NodejsFunction(this, 'PulseFeedFetcher', {
      functionName: 'PulseFeedFetcher',
      entry: path.join(__dirname, '../../src/fetcher/handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.seconds(90),
      tracing: Tracing.ACTIVE,
      bundling: { minify: true, sourcesContent: false },
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
        MAX_BYTES: '4000000',
      },
    });
    rawBucket.grantWrite(fetcher);
    fetcher.addEventSource(new SqsEventSource(toFetch, {
      batchSize: 5,
      maxBatchingWindow: Duration.seconds(5),
    }));

    // DynamoDB: summaries table
    const summaries = new Table(this, 'PulseFeedSummaries', {
      partitionKey: { name: 'post_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY, // DEV ONLY
    });

    // Lambda: summariser (UK spelling to match your deployed name)
    const summariser = new NodejsFunction(this, 'PulseFeedSummariser', {
      functionName: 'PulseFeedSummariser',
      entry: path.join(__dirname, '../../src/summariser/handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      memorySize: 1024,
      timeout: Duration.seconds(60),
      tracing: Tracing.ACTIVE,
      bundling: { minify: true, sourcesContent: false },
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
        SUMMARIES_TABLE: summaries.tableName,          // <-- make sure this line is present
        BEDROCK_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
        BEDROCK_REGION: 'eu-west-2',
        SUMMARY_CHAR_LIMIT: '280',
        // SKIP_BEDROCK: 'true', // optional
      },
    });

    rawBucket.grantRead(summariser);
    rawBucket.grantWrite(summariser);
    summaries.grantWriteData(summariser);
    summariser.addToRolePolicy(new PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['*'], // tighten to specific model ARN if desired
    }));

    // S3 -> summariser on text.txt created
    summariser.addEventSource(new S3EventSource(rawBucket, {
      events: [EventType.OBJECT_CREATED],
      filters: [{ suffix: 'text.txt' }],
    }));

    // Exports (handy in CLI)
    this.exportValue(posts.tableName, { name: 'PulseFeedPostsTableName' });
    this.exportValue(feedsParam.parameterName, { name: 'PulseFeedFeedsParamName' });
    this.exportValue(rawBucket.bucketName, { name: 'PulseFeedRawContentBucketName' });
    this.exportValue(summaries.tableName, { name: 'PulseFeedSummariesTableName' });
  }
}
