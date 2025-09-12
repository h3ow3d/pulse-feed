# PulseFeed

PulseFeed is a serverless pipeline that ingests any RSS feed, detects new items, processes them with AI via Amazon Bedrock, and stores or publishes enriched summaries. Future extensions include publishing to platforms such as Twitter/X.

## What it does
- Polls configured RSS/Atom feeds on a fixed schedule (default: every 15 minutes).
- Detects new items using `ETag`, `Last-Modified`, and idempotency checks.
- Publishes new items to an SQS queue.
- Summarises and tags content with Bedrock models.
- Stores raw and enriched outputs in S3, with metadata in DynamoDB.
- Provides observability through CloudWatch dashboards and alarms.

## Architecture (MVP)

```
EventBridge (15m)
     │
     ▼
 Ingestor Lambda
   - Fetch feeds
   - Dedupe
   - Publish
     │
     ▼
     SQS Queue
     │
     ▼
 AI Worker Lambda
   - Summarise via Bedrock
   - Store in S3
   - Index in DynamoDB
```

## Roadmap
- Establish project structure and CI for Terraform
- Core infrastructure: S3, DynamoDB, SQS (+ DLQ)
- Ingestor Lambda: feed polling and dedupe
- AI Worker Lambda: Bedrock summarisation pipeline
- Observability: dashboards and alarms
- Twitter/X publishing
- Semantic search (embeddings + OpenSearch/pgvector)

## Repository layout

```
/docs                 → design notes, runbooks
/infra                → Terraform IaC
  /envs/dev           → dev environment configs
  /envs/prod          → prod environment configs
/.github/workflows    → CI/CD pipelines
```

## Getting started
1. Clone the repository
   ```bash
   git clone git@github.com:your-org/pulse-feed.git
   cd pulse-feed
   ```
2. Initialise Terraform (dev environment)
   ```bash
   cd infra/envs/dev
   terraform init
   terraform plan
   ```
3. Configure feeds by editing `terraform.tfvars` in the environment folder
4. Deploy
   ```bash
   terraform apply
   ```
