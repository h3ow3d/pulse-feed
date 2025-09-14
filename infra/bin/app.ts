import { App } from 'aws-cdk-lib';
import { PulseFeedStack } from '../lib/pulse-feed-stack';

const app = new App();
new PulseFeedStack(app, 'PulseFeedStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
