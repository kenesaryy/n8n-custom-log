/* eslint-disable n8n-nodes-base/node-param-type-options-password-missing */
/* eslint-disable n8n-nodes-base/node-param-required-false */
import { IExecuteFunctions } from 'n8n-workflow';
import {
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeConnectionType,
} from 'n8n-workflow';

import axios from 'axios';
import textract from 'textract';
import { execFile } from 'child_process';
import { writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

async function runExternalRanker(text: string, maxTokens: number) {
  const tempPath = join(tmpdir(), `n8n_temp_rank_${Date.now()}.txt`);
  await writeFile(tempPath, text, 'utf8');

  return new Promise<{ text: string; tokenCount: number; sentenceCount: number }>((resolve, reject) => {
    execFile('node', ['nodes/ExtractUsefulPayload/ranker.mjs', tempPath, String(maxTokens)], { encoding: 'utf8' }, async (err, stdout, stderr) => {
      await rm(tempPath); // cleanup

      if (err) return reject(new Error(stderr || err.message));
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (e) {
        reject(new Error('Failed to parse ranker output'));
      }
    });
  });
}

export class ExtractUsefulPayload implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Extract Useful Payload',
    name: 'extractUsefulPayload',
    group: ['transform'],
    version: 1,
    description: 'Extracts compressed useful text from file URL using textract and transformers',
    defaults: {
      name: 'Extract Useful Payload',
    },
    inputs: [NodeConnectionType.Main],
    outputs: [NodeConnectionType.Main],
    properties: [
      {
        displayName: 'File URL',
        name: 'url',
        type: 'string',
        default: '',
        required: true,
      },
      {
        displayName: 'Max Tokens',
        name: 'maxTokens',
        type: 'number',
        default: 2048,
        required: true,
      },
      {
        displayName: 'Authorization Token',
        name: 'token',
        type: 'string',
        default: '',
        required: false,
        description: 'Optional bearer token for accessing private files (e.g., Slack URLs)',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const url = this.getNodeParameter('url', i) as string;
        const maxTokens = this.getNodeParameter('maxTokens', i) as number;
        const token = this.getNodeParameter('token', i, false) as string;

        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        const buffer = Buffer.from(response.data);
        const filename = url.split('/').pop() || 'file.txt';

        let rawText: string = '';
        try {
          rawText = await new Promise((resolve, reject) => {
            textract.fromBufferWithName(filename, buffer, (err: unknown, text: string) => {
              if (err || !text || !text.trim()) reject(err || new Error('Empty result'));
              else resolve(text);
            });
          });
          console.log('✅ Textract успешно извлек текст.');
        } catch (err) {
          console.warn(`⚠️ Textract не справился, fallback к raw UTF-8.`);
          rawText = buffer.toString('utf-8');
        }

        const { text, tokenCount, sentenceCount } = await runExternalRanker(rawText, maxTokens);

        returnData.push({
          json: {
            text: text,
            metadata: {
              originalLength: rawText.length,
              finalTokenCount: tokenCount,
              sentenceCount,
              filename,
            },
          },
        });
      } catch (error: any) {
        returnData.push({
          json: {
            text: '',
            error: error.message,
            metadata: {
              originalLength: 0,
              finalTokenCount: 0,
              sentenceCount: 0,
            },
          },
        });
      }
    }

    return [returnData];
  }
}
