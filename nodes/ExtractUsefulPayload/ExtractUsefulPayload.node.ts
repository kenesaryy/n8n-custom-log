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
import { encode } from 'gpt-3-encoder';

export class ExtractUsefulPayload implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Extract Useful Payload',
    name: 'extractUsefulPayload',
    group: ['transform'],
    version: 1,
    description: 'Extracts compressed useful text from file URL using textract',
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

        // 1. Загружаем файл
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        const buffer = Buffer.from(response.data);

        // 2. Определяем имя файла (важно для textract)
        const filename = url.split('/').pop() || 'file.txt';

        // 3. Извлекаем текст с помощью textract
        const rawText: string = await new Promise((resolve, reject) => {
          textract.fromBufferWithName(filename, buffer, (err: unknown, text: string) => {
            if (err) reject(err);
            else resolve(text || '');
          });
        });

        console.log('Extracted text length:', rawText.length);

        // 4. Фильтрация и очистка
        const cleaned = rawText
          .replace(/Figure\s?\d+.*|Chart\s?\d+.*|Image\s?\d+.*/gi, '')
          .replace(/(\/[\w\-\.\/]+)+/g, '')
          .replace(/[{<][^}>\n]+[}>]/g, '')
          .replace(/^[^\.\n]{80,}$/gm, '')
          .replace(/\s+/g, ' ')
          .replace(/\n{2,}/g, '\n')
          .trim();

        // 5. Делим по предложениям (просто по точкам и пробелам)
        const rawSentences = cleaned.split(/(?<=\.)\s+/g);
        const sentences = rawSentences.filter((s) => {
          const t = s.trim();
          return (
            t.length > 30 &&
            t.length < 500 &&
            /\w{3,}/.test(t) &&
            !/copyright|terms|page \d+|privacy policy|cookie/i.test(t)
          );
        });

        // 6. Обрезаем по токенам
        const result: string[] = [];
        let tokenCount = 0;

        for (const sentence of sentences) {
          const tokens = encode(sentence);
          if (tokenCount + tokens.length > maxTokens) break;
          result.push(sentence);
          tokenCount += tokens.length;
        }

        const finalText = result.join(' ').trim();

        returnData.push({
          json: {
            text: finalText,
            metadata: {
              originalLength: rawText.length,
              cleanedLength: cleaned.length,
              sentenceCount: sentences.length,
              finalTokenCount: tokenCount,
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
              cleanedLength: 0,
              sentenceCount: 0,
              finalTokenCount: 0,
            },
          },
        });
      }
    }

    return [returnData];
  }
}
