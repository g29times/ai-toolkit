import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { getDatasetsRoot } from '@/server/settings';

function findImagesRecursively(dir: string): string[] {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
  let results: string[] = [];

  const items = fs.readdirSync(dir);
  for (const item of items) {
    const itemPath = path.join(dir, item);
    const stat = fs.statSync(itemPath);

    if (stat.isDirectory() && item !== '_controls' && !item.startsWith('.')) {
      results = results.concat(findImagesRecursively(itemPath));
    } else {
      const ext = path.extname(itemPath).toLowerCase();
      if (imageExtensions.includes(ext)) {
        results.push(itemPath);
      }
    }
  }

  return results;
}

function runCommand(command: string, args: string[], options: { cwd?: string } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: unknown) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk: unknown) => {
      stderr += String(chunk);
    });

    child.on('error', (err: unknown) => {
      reject(err);
    });

    child.on('close', (code: number | null) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const DEFAULT_PROMPT =
  'Write a concise, factual caption describing the main subject, appearance, clothing, colors, environment, lighting, camera angle, and composition. Use simple comma-separated phrases. Do not mention artist names, watermarks, or text.';

export async function POST(request: Request) {
  try {
    const datasetsPath = await getDatasetsRoot();
    const body = await request.json();
    const { datasetName } = body as { datasetName?: string };

    if (!datasetName || typeof datasetName !== 'string') {
      return NextResponse.json({ error: 'datasetName is required' }, { status: 400 });
    }

    const datasetFolder = path.join(datasetsPath, datasetName);

    if (!fs.existsSync(datasetFolder)) {
      return NextResponse.json({ error: `Folder '${datasetName}' not found` }, { status: 404 });
    }

    const isAllowed = datasetFolder.startsWith(datasetsPath) && !datasetFolder.includes('..');
    if (!isAllowed) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const imagePaths = findImagesRecursively(datasetFolder);
    if (imagePaths.length === 0) {
      return NextResponse.json({ success: true, message: 'No images found', images: 0 });
    }

    const tmpFile = path.join(os.tmpdir(), `joycaption-filelist-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    fs.writeFileSync(tmpFile, imagePaths.join('\n'), 'utf-8');

    const repoRoot = path.resolve(process.cwd(), '../..');
    const scriptPath = path.resolve(repoRoot, 'joycaption/scripts/batch-caption.py');

    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json(
        { error: `JoyCaption script not found at ${scriptPath}. Please check repo layout.` },
        { status: 500 },
      );
    }

    const args = [
      scriptPath,
      '--filelist',
      tmpFile,
      '--prompt',
      DEFAULT_PROMPT,
      '--batch-size',
      '1',
      '--num-workers',
      '0',
      '--max-new-tokens',
      '256',
    ];

    const pythonBins = ['python3', 'python'];

    let lastResult: { code: number | null; stdout: string; stderr: string } | null = null;
    for (const pythonBin of pythonBins) {
      lastResult = await runCommand(pythonBin, args, { cwd: repoRoot });
      if (lastResult.code === 0) break;
    }

    const code = lastResult?.code ?? 1;
    const stdout = lastResult?.stdout ?? '';
    const stderr = lastResult?.stderr ?? '';

    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }

    if (code !== 0) {
      return NextResponse.json(
        {
          error: 'JoyCaption failed',
          code,
          stderr: stderr.slice(-8000),
          stdout: stdout.slice(-8000),
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, images: imagePaths.length, stdout: stdout.slice(-8000) });
  } catch (error) {
    console.error('autoCaption error:', error);
    return NextResponse.json(
      { error: `autoCaption failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }
}
