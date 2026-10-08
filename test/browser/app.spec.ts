import { test, expect } from '@playwright/test';

test('web terminal, result isolation and password editing work without login', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'demo', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '接管终端', exact: true }).click();
  await page.getByLabel('命令', { exact: true }).fill("printf 'browser-result'");
  await page.getByRole('button', { name: '执行并获取结果' }).click();
  await expect(page.locator('.result pre')).toHaveText('browser-result');
  await expect(page.locator('.result strong')).toContainText('退出码 0');
  await page.getByRole('button', { name: '释放', exact: true }).click();
  await page.getByRole('button', { name: /^用户名与密码/ }).click();
  await page.getByLabel('堡垒机密码').fill('browser-test-only-password');
  await page.getByRole('checkbox', { name: /记住用户名密码/ }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: /用户名与密码.*已记住/ })).toBeVisible();
  await page.getByRole('button', { name: /^用户名与密码/ }).click();
  await expect(page.getByLabel('堡垒机密码')).toHaveValue('');
  await page.getByLabel('堡垒机密码').fill('edited-browser-test-password');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const state = await (await request.get('/api/state')).json();
  expect(JSON.stringify(state)).not.toContain('edited-browser-test-password');
  await page.getByRole('button', { name: '接管终端', exact: true }).click();
  await expect(page.locator('.terminal-title')).toContainText('你已获得输入权');
  await page.locator('.terminal .xterm-screen').click();
  await page.keyboard.type('echo interactive-result');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.getByTestId('terminal').textContent())
    .toContain('interactive-result');
  await page.getByRole('button', { name: '释放', exact: true }).click();
  await expect(page.locator('.terminal-title')).toContainText('只读监控');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'demo', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test('default commands retain the current Shell and advanced commands isolate environment changes', async ({
  page,
}) => {
  await page.goto('/');
  const execute = page.getByRole('button', { name: '执行并获取结果' });
  await page
    .getByLabel('命令', { exact: true })
    .fill('WEB_LOCAL=retained; builtin printf initialized');
  await expect(execute).toBeDisabled();
  await page.getByRole('button', { name: '接管终端', exact: true }).click();
  await execute.click();
  await expect(page.locator('.result pre')).toHaveText('initialized');
  await page.getByLabel('命令', { exact: true }).fill('builtin printf "%s" "$WEB_LOCAL"');
  await page.getByLabel('工作目录').fill('/tmp');
  await execute.click();
  await expect(page.locator('.result pre')).toHaveText('retained');
  await page.getByLabel('工作目录').fill('');
  await page.getByLabel('命令', { exact: true }).fill('pwd');
  await execute.click();
  await expect(page.locator('.result pre')).toHaveText('/tmp\n');
  await page.getByText('高级选项', { exact: true }).click();
  await page.getByRole('checkbox', { name: '独立子 Shell', exact: true }).check();
  await page.getByLabel('命令', { exact: true }).fill('cd /; printf "%s" "${WEB_LOCAL-unset}"');
  await execute.click();
  await expect(page.locator('.result pre')).toHaveText('unset');
  await expect(page.locator('.result strong')).toContainText('独立子 Shell');
  await page.getByRole('checkbox', { name: '独立子 Shell', exact: true }).uncheck();
  await page.getByLabel('命令', { exact: true }).fill('builtin printf "%s:%s" "$PWD" "$WEB_LOCAL"');
  await execute.click();
  await expect(page.locator('.result pre')).toHaveText('/tmp:retained');
  await page.getByRole('button', { name: '释放', exact: true }).click();
  await expect(execute).toBeDisabled();
  await page.getByRole('checkbox', { name: '独立子 Shell', exact: true }).check();
  await page.getByLabel('命令', { exact: true }).fill('printf auto-lease');
  await execute.click();
  await expect(page.locator('.result pre')).toHaveText('auto-lease');
  await expect(page.locator('.terminal-title')).toContainText('只读监控');
});
test('takeover revokes an agent token and cross-origin calls are rejected', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/rpc', {
    data: { action: 'acquire', args: { asset: 'demo' }, owner: 'test-agent' },
  });
  const acquired = await response.json();
  expect(acquired.ok).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: '接管并撤销占用' }).click();
  await expect(page.locator('.terminal-title')).toContainText('你已获得输入权');
  const old = await request.post('/api/rpc', {
    data: {
      action: 'renew',
      args: { asset: 'demo', leaseToken: acquired.result.lease.token },
    },
  });
  expect((await old.json()).error.code).toBe('LEASE_INVALID');
  const blocked = await request.post('/api/rpc', {
    headers: { Origin: 'https://unrelated.example' },
    data: { action: 'list', args: {} },
  });
  expect(blocked.status()).toBe(403);
  await page.getByRole('button', { name: '释放', exact: true }).click();
});
