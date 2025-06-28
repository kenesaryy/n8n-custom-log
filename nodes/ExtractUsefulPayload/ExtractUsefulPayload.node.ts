/* eslint-disable n8n-nodes-base/node-param-required-false */
/* eslint-disable n8n-nodes-base/node-param-type-options-password-missing */
import { IExecuteFunctions } from 'n8n-workflow';
import {
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeConnectionType
} from 'n8n-workflow';

import axios from 'axios';

import { fromBuffer } from 'file-type';
// @ts-ignore
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
// @ts-ignore
import { convert } from 'html-to-text';
// @ts-ignore
import removeMd from 'remove-markdown';
import nlp from 'compromise';
import { encode } from 'gpt-3-encoder';

export class ExtractUsefulPayload implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Extract Useful Payload',
    name: 'extractUsefulPayload',
    group: ['transform'],
    version: 1,
    description: 'Extracts compressed useful text from file URL',
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
      const url = this.getNodeParameter('url', i) as string;
      const maxTokens = this.getNodeParameter('maxTokens', i) as number;
      const token = this.getNodeParameter('token', i, false) as string;

      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      console.log('Content-Type:', response.headers['content-type']);
      const buffer = Buffer.from(response.data);
      const fileType = await fromBuffer(buffer);
      console.log(78, fileType);
      let ext: string = "txt";
      let rawText = '';

      // if (fileType?.ext) {
      //   ext = fileType.ext;
      // } else {
      //   const contentType = response.headers['content-type'] || '';
      //   if (contentType.includes('html')) ext = 'html';
      //   else if (contentType.includes('markdown')) ext = 'md';
      //   else if (contentType.includes('plain')) ext = 'txt';
        // else ext = 'txt';
      // }
      console.log(buffer);

      if (ext === 'pdf') {
        rawText = (await pdfParse(buffer)).text;
      } else if (ext === 'docx') {
        rawText = (await mammoth.extractRawText({ buffer })).value;
      } else if (ext === 'html') {
        rawText = convert(buffer.toString(), { wordwrap: false });
      } else if (ext === 'md') {
        rawText = removeMd(buffer.toString());
      } else {
        rawText = buffer.toString('utf-8');
      }
      console.log(104, rawText);

      const cleaned = rawText
        .replace(/```[\s\S]+?```/g, '')
        .replace(/^[ \t]{2,}.+$/gm, '')
        .replace(/Figure\s?\d+.*|Chart\s?\d+.*|Image\s?\d+.*/gi, '')
        .replace(/(\/[\w\-\.\/]+)+/g, '')
        .replace(/[{<][^}>\n]+[}>]/g, '')
        .replace(/^[^\.\n]{80,}$/gm, '')
        .replace(/\n{2,}/g, '\n')
        .trim();

      const sentences = nlp(cleaned)
        .sentences()
        .filter(s => {
          //@ts-ignore
          const t = s.text();
          return (
            t.length > 50 &&
            /\w{4,}/.test(t) &&
            !/copyright|terms|page \d+/i.test(t)
          );
        })
        .out('array');

      const result: string[] = [];
      let tokenCount = 0;
      for (const s of sentences) {
        const tokens = encode(s);
        if (tokenCount + tokens.length > maxTokens) break;
        result.push(s);
        tokenCount += tokens.length;
      }

      returnData.push({ json: { text: result.join(' ') } });
    }

    return [returnData];
  }
}