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


// Вспомогательная функция для определения типа файла
function detectFileType(buffer: Buffer, contentType: string, url: string): string {
  // Анализируем первые 2000 символов содержимого
  const textPreview = buffer.toString('utf-8', 0, Math.min(2000, buffer.length)).toLowerCase().trim();
  const contentTypeLower = contentType.toLowerCase();
  const urlLower = url.toLowerCase();

  // JSON проверки
  if (contentTypeLower.includes('json') || 
      contentTypeLower.includes('application/json') ||
      urlLower.includes('.json') ||
      (textPreview.startsWith('{') && textPreview.includes('"')) ||
      (textPreview.startsWith('[') && textPreview.includes('{'))) {
    return 'json';
  }

  // HTML проверки
  if (contentTypeLower.includes('html') || 
      textPreview.includes('<!doctype html') || 
      textPreview.includes('<html') || 
      textPreview.includes('<head>') || 
      textPreview.includes('<body>') ||
      textPreview.includes('<div') ||
      urlLower.includes('.html') || 
      urlLower.includes('.htm')) {
    return 'html';
  }

  // Markdown проверки
  if (contentTypeLower.includes('markdown') || 
      contentTypeLower.includes('text/markdown') ||
      textPreview.includes('# ') || 
      textPreview.includes('## ') || 
      textPreview.includes('```') ||
      textPreview.includes('**') ||
      urlLower.includes('.md') || 
      urlLower.includes('.markdown')) {
    return 'md';
  }

  // PDF проверки (magic bytes)
  if (buffer.toString('binary', 0, 4) === '%PDF' || 
      contentTypeLower.includes('pdf') ||
      urlLower.includes('.pdf')) {
    return 'pdf';
  }

  // DOCX проверки (magic bytes для ZIP)
  if (buffer[0] === 0x50 && buffer[1] === 0x4B && 
      (contentTypeLower.includes('document') || 
       contentTypeLower.includes('docx') || 
       contentTypeLower.includes('officedocument') ||
       urlLower.includes('.docx') || 
       urlLower.includes('.doc'))) {
    return 'docx';
  }

  // Plain text или неизвестный формат
  return 'txt';
}

// Функция для извлечения текста из JSON объекта
function extractTextFromJson(obj: any, path: string = ''): string {
  const textParts: string[] = [];
  
  if (typeof obj === 'string') {
    // Если строка содержит полезную информацию (не ключи/идентификаторы)
    if (obj.length > 10 && !/^[a-zA-Z0-9_-]+$/.test(obj)) {
      textParts.push(obj);
    }
  } else if (typeof obj === 'number' || typeof obj === 'boolean') {
    // Числа и булевы значения обычно не очень полезны для анализа текста
    return '';
  } else if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      const itemText = extractTextFromJson(item, `${path}[${index}]`);
      if (itemText) textParts.push(itemText);
    });
  } else if (obj && typeof obj === 'object') {
    Object.entries(obj).forEach(([key, value]) => {
      // Добавляем ключ как контекст, если он описательный
      if (key.length > 2 && !/^(id|_id|key|idx)$/i.test(key)) {
        const keyText = key.replace(/[_-]/g, ' ').toLowerCase();
        if (keyText.length > 3) {
          textParts.push(`${keyText}:`);
        }
      }
      
      const valueText = extractTextFromJson(value, `${path}.${key}`);
      if (valueText) textParts.push(valueText);
    });
  }
  
  return textParts.join(' ').trim();
}

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
      try {
        const url = this.getNodeParameter('url', i) as string;
        const maxTokens = this.getNodeParameter('maxTokens', i) as number;
        const token = this.getNodeParameter('token', i, false) as string;

        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        console.log('Content-Type:', response.headers['content-type']);
        const buffer = Buffer.from(response.data);
        
        // Определяем тип файла
        let ext: string = "txt";
        let rawText = '';

        // Сначала пробуем file-type для бинарных форматов
        const fileType = await fromBuffer(buffer);
        console.log('file-type result:', fileType);

        if (fileType?.ext && ['pdf', 'docx', 'doc'].includes(fileType.ext)) {
          // file-type хорошо работает с бинарными форматами
          ext = fileType.ext;
          console.log('Binary file type detected:', ext);
        } else {
          // Для текстовых форматов используем нашу функцию
          ext = detectFileType(buffer, response.headers['content-type'] || '', url);
          console.log('Text file type detected:', ext);
        }

        console.log('Final extension:', ext);

        // Извлекаем текст в зависимости от типа файла
        switch (ext) {
          case 'pdf':
            rawText = (await pdfParse(buffer)).text;
            break;
            
          case 'docx':
            rawText = (await mammoth.extractRawText({ buffer })).value;
            break;
            
          case 'html':
          case 'htm':
            // Конвертируем HTML в текст
            const htmlString = buffer.toString('utf-8');
            rawText = convert(htmlString, { 
              wordwrap: false,
              ignoreHref: true,
              ignoreImage: true,
              preserveNewlines: false,
              uppercaseHeadings: false
            });
            break;
            
          case 'md':
          case 'markdown':
            rawText = removeMd(buffer.toString('utf-8'));
            break;

          case 'json':
            try {
              const jsonString = buffer.toString('utf-8');
              const jsonData = JSON.parse(jsonString);
              // Извлекаем значения из JSON в читаемый текст
              rawText = extractTextFromJson(jsonData);
            } catch (error) {
              console.error('Error parsing JSON:', error);
              // Если JSON невалидный, обрабатываем как обычный текст
              rawText = buffer.toString('utf-8');
            }
            break;
            
          case 'txt':
          case 'text':
          default:
            rawText = buffer.toString('utf-8');
            break;
        }

        console.log('Raw text length:', rawText.length);
        console.log('Raw text preview:', rawText.substring(0, 200));

        // Очищаем текст
        const cleaned = rawText
          .replace(/Figure\s?\d+.*|Chart\s?\d+.*|Image\s?\d+.*/gi, '') // Удаляем подписи к изображениям
          .replace(/(\/[\w\-\.\/]+)+/g, '') // Удаляем пути к файлам
          .replace(/[{<][^}>\n]+[}>]/g, '') // Удаляем теги и скобки
          .replace(/^[^\.\n]{80,}$/gm, '') // Удаляем длинные строки без точек
          .replace(/\s+/g, ' ') // Заменяем множественные пробелы на одинарные
          .replace(/\n{2,}/g, '\n') // Заменяем множественные переносы строк
          .trim();

        console.log('Cleaned text length:', cleaned.length);
        console.log('Cleaned text preview:', cleaned.substring(0, 200));

        // Разбиваем на предложения и фильтруем
        const sentences = nlp(cleaned)
          .sentences()
          .filter(s => {
            //@ts-ignore
            const t = s.text();
            return (
              t.length > 30 && // Минимальная длина предложения
              t.length < 500 && // Максимальная длина предложения
              /\w{3,}/.test(t) && // Содержит слова минимум 3 символа
              !/copyright|terms|page \d+|privacy policy|cookie/i.test(t) && // Исключаем служебную информацию
              (t.match(/\./g) || []).length <= 5 // Не более 5 точек в предложении
            );
          })
          .out('array');

        console.log('Filtered sentences count:', sentences.length);

        // Собираем результат с учетом лимита токенов
        const result: string[] = [];
        let tokenCount = 0;
        
        for (const sentence of sentences) {
          const tokens = encode(sentence);
          if (tokenCount + tokens.length > maxTokens) {
            console.log('Token limit reached at', tokenCount, 'tokens');
            break;
          }
          result.push(sentence);
          tokenCount += tokens.length;
        }

        const finalText = result.join(' ').trim();
        console.log('Final text length:', finalText.length);
        console.log('Final token count:', tokenCount);

        returnData.push({ 
          json: { 
            text: finalText,
            metadata: {
              fileType: ext,
              originalLength: rawText.length,
              cleanedLength: cleaned.length,
              sentenceCount: sentences.length,
              finalTokenCount: tokenCount
            }
          } 
        });

      } catch (error) {
        console.error('Error processing file:', error);
        returnData.push({ 
          json: { 
            text: '',
            error: error.message,
            metadata: {
              fileType: 'unknown',
              originalLength: 0,
              cleanedLength: 0,
              sentenceCount: 0,
              finalTokenCount: 0
            }
          } 
        });
      }
    }

    return [returnData];
  }
}