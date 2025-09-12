terraform {
  backend "s3" {
    bucket         = "pulse-feed-tfstate"
    key            = "pulse-feed/terraform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "pulse-feed-tf-locks"
    encrypt        = true
  }
}
