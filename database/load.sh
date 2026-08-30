#!bin/bash

sudo -u postgres psql < providers_schema.sql
sudo -u postgres psql < mock_providers.sql
