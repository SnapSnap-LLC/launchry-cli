#!/usr/bin/env node
import {
  ClientError,
  SkillHarborClient,
  checkUpdates,
  deleteCredential,
  installSkill,
  isMainModule,
  openBrowser,
  skillsDirectory,
} from './core.js';
import { product } from './product.js';

const HELP = `${product.name} — 团队 Skill 注册中心

用法: ${product.cli} <command> [options]
  login                         在浏览器批准本机访问
  status                        显示当前账户和配额（不显示凭据）
  logout                        撤销并删除本机凭据
  search <query>                搜索你有权查看的 Skill
  install <slug>                安装选定的 Skill
  update [slug] --check         检查可用更新，不下载
  update <slug> --version <v>   更新到明确选择的版本，备份旧文件

选项:
  --url <origin>                ${product.siteId ? '本地调试地址' : '服务地址，也可用 SKILLHARBOR_URL'}
  --agent <name>                shared / codex / cursor / claude-code
  --target <directory>          显式指定 Skills 父目录（不能与 --agent 同用）
  --version <version>           指定已发布版本
  --json                        JSON 输出

默认 API: ${product.apiOrigin ?? 'http://127.0.0.1:4310'}；默认安装目录 ~/.agents/skills。
MCP: ${product.mcp}（stdio 客户端直接运行该命令，避免 npm 启动横幅）。`;

export function parseArgs(args: string[]): {
  command: string;
  values: string[];
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--check', '--json', '--help', '-h'].includes(arg)) {
      flags[arg.replace(/^--?/, '')] = true;
      continue;
    }
    if (arg.startsWith('--')) {
      if (
        !['--url', '--target', '--agent', '--version'].includes(arg) ||
        !args[i + 1] ||
        args[i + 1].startsWith('--')
      )
        throw new ClientError('未知选项或缺少参数: ' + arg);
      flags[arg.slice(2)] = args[++i];
    } else values.push(arg);
  }
  if (flags.target && flags.agent) throw new ClientError('--target 与 --agent 不能同时指定。');
  return { command: values.shift() || 'help', values, flags };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { command, values, flags } = parseArgs(args);
  if (command === 'help' || flags.help || flags.h) {
    console.log(HELP);
    return;
  }
  const client = new SkillHarborClient(flags.url as string | undefined);
  const output = (value: unknown) =>
    console.log(typeof value === 'string' && !flags.json ? value : JSON.stringify(value, null, 2));
  if (command === 'login') {
    const flow = await client.startDevice();
    console.log(`请在浏览器确认设备码 ${flow.userCode}\n${flow.verificationUri}`);
    await openBrowser(flow.verificationUri);
    while (Date.now() < flow.startedAt + flow.expiresIn * 1000) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1000, flow.nextPollAt - Date.now())),
      );
      const result = await client.pollDevice(flow);
      if (result.status === 'connected') {
        const account = await client.request('/api/me');
        output({ connected: true, user: account.user.name, expiresAt: result.expiresAt });
        return;
      }
    }
    throw new ClientError('设备码已过期，请重新运行 login。');
  }
  if (command === 'status') {
    output(await client.request('/api/me'));
    return;
  }
  if (command === 'logout') {
    const result = await client.logout();
    output({ connected: false, ...result });
    return;
  }
  if (command === 'search') {
    output(await client.request('/api/skills?q=' + encodeURIComponent(values.join(' '))));
    return;
  }
  const directory = skillsDirectory(
    flags.agent as string | undefined,
    flags.target as string | undefined,
  );
  if (command === 'install') {
    if (!values[0]) throw new ClientError('请指定 Skill 标识。');
    output(
      await installSkill(client, values[0], directory, {
        expectedVersion: flags.version as string | undefined,
      }),
    );
    return;
  }
  if (command === 'update') {
    if (flags.check) {
      const updates = await checkUpdates(client, directory);
      output(values[0] ? updates.filter((item) => item.slug === values[0]) : updates);
      return;
    }
    if (!values[0] || typeof flags.version !== 'string')
      throw new ClientError(
        '先运行 update --check，再使用 update <slug> --version <version> 更新选定版本。',
      );
    output(
      await installSkill(client, values[0], directory, {
        update: true,
        expectedVersion: flags.version,
      }),
    );
    return;
  }
  throw new ClientError('未知命令。使用 --help 查看用法。');
}
if (isMainModule(import.meta.url))
  main().catch((error: unknown) => {
    const safe =
      error instanceof ClientError
        ? `${error.code}: ${error.message}${error.retryAfter ? `（${error.retryAfter} 秒后重试）` : ''}`
        : '请求失败。请检查服务地址、网络和服务端日志。';
    console.error(safe);
    process.exitCode = 1;
  });
