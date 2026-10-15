const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync('Y:/qhDF/index.html', 'utf8');

const results = [];
const check = (name, cond, extra) => results.push({ name, pass: !!cond, extra });
const wait = (ms = 0) => new Promise(r => setTimeout(r, ms));

function boot(url) {
  const calls = { signUp: [], signIn: [], signOut: [], reset: [], update: [] };
  const subs = [];
  const hardErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (/Not implemented: navigation/.test(e.message)) return; // location.reload 在 jsdom 中无法实现
    hardErrors.push(e.message);
  });
  vc.on('error', m => hardErrors.push('console.error: ' + m));

  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.supabase = {
        createClient: () => ({
          auth: {
            signUp: async c => { calls.signUp.push(c); return { data: { user: { id: 'u1' }, session: null }, error: null }; },
            signInWithPassword: async c => { calls.signIn.push(c); return { data: { session: { access_token: 'x' } }, error: null }; },
            signOut: async () => { calls.signOut.push(1); },
            resetPasswordForEmail: async (email, opts) => { calls.reset.push({ email, opts }); return { data: {}, error: null }; },
            updateUser: async patch => { calls.update.push(patch); return { data: { user: { id: 'u1' } }, error: null }; },
            onAuthStateChange: cb => { subs.push(cb); return { data: { subscription: { unsubscribe() {} } } }; }
          }
        })
      };
    }
  });

  const { window } = dom;
  const doc = window.document;
  const api = {
    dom, window, doc, calls, subs, hardErrors,
    $: s => doc.querySelector(s),
    has: s => !!doc.querySelector(s),
    show: s => doc.querySelector(s).classList.contains('show'),
    click: el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })),
    submit: f => f.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    key: k => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true })),
    fireAuth: (event, session) => subs.forEach(cb => cb(event, session))
  };
  return api;
}

(async () => {
  /* ---------- 场景 A：部署在 https 域名下 ---------- */
  const t = boot('https://demo.example.com/game/');
  const { doc } = t;
  await wait(20);

  check('A: 四个弹窗都在 DOM 中', ['#mask-login', '#mask-signup', '#mask-forgot', '#mask-reset'].every(t.has));
  check('A: 初始全部不显示', ['#mask-login', '#mask-signup', '#mask-forgot', '#mask-reset'].every(s => !t.show(s)));

  /* 登录/注册基础链路（回归） */
  t.click(t.$('#btn-login'));
  await wait();
  check('A: 点「登录」只开登录弹窗', t.show('#mask-login') && !t.show('#mask-signup'));
  t.click(t.$('#mask-login [data-auth-open="signup"]'));
  await wait();
  check('A: 登录弹窗可跳到注册弹窗', t.show('#mask-signup') && !t.show('#mask-login'));
  t.click(t.$('#mask-signup [data-auth-open="login"]'));
  await wait();
  check('A: 注册弹窗可跳回登录弹窗', t.show('#mask-login') && !t.show('#mask-signup'));

  /* 忘记密码入口 */
  t.click(t.$('#mask-login [data-auth-act="forgot"]'));
  await wait();
  check('A: 「忘记密码」打开重置密码弹窗', t.show('#mask-forgot') && !t.show('#mask-login'));
  check('A: 当前地址与站点地址不同时提示跳转目标',
    t.show('#forgot-msg') && /qhqiqi\.cn\/Delta-Force\//.test(t.$('#forgot-msg').textContent),
    t.$('#forgot-msg').textContent.slice(0, 50));

  /* 忘记密码校验 */
  t.$('#fg-email').value = 'not-an-email';
  t.submit(t.$('#form-forgot'));
  await wait();
  check('A: 忘记密码-非法邮箱被拦下', t.calls.reset.length === 0 && /邮箱/.test(t.$('#fg-email-err').textContent));

  t.$('#fg-email').value = 'me@example.com';
  t.submit(t.$('#form-forgot'));
  await wait(30);
  check('A: 忘记密码-发出 resetPasswordForEmail', t.calls.reset.length === 1 && t.calls.reset[0].email === 'me@example.com');
  check('A: redirectTo 指向已配置的站点地址',
    t.calls.reset[0] && t.calls.reset[0].opts.redirectTo === 'https://qhqiqi.cn/Delta-Force/',
    t.calls.reset[0] && t.calls.reset[0].opts.redirectTo);
  check('A: 发送后给出「查收邮件」提示', t.show('#forgot-msg') && /已发出/.test(t.$('#forgot-msg').textContent));

  /* 点邮件链接跳回 -> PASSWORD_RECOVERY -> 设置新密码弹窗 */
  t.click(t.$('#mask-forgot [data-auth-open="login"]'));
  await wait();
  t.fireAuth('PASSWORD_RECOVERY', { user: { email: 'me@example.com' } });
  await wait();
  check('A: PASSWORD_RECOVERY 弹出设置新密码弹窗', t.show('#mask-reset'));
  check('A: 重置弹窗打开时其它弹窗都关掉', !t.show('#mask-login') && !t.show('#mask-signup') && !t.show('#mask-forgot'));

  /* 重置弹窗不可随手关掉 */
  t.key('Escape');
  await wait();
  check('A: 重置弹窗按 Esc 不会消失', t.show('#mask-reset'));
  t.click(t.$('#mask-reset'));
  await wait();
  check('A: 重置弹窗点遮罩不会消失', t.show('#mask-reset'));

  /* 新密码校验 */
  t.$('#rs-pwd').value = '123';
  t.$('#rs-pwd2').value = '123';
  t.submit(t.$('#form-reset'));
  await wait();
  check('A: 新密码少于 6 位被拦下', t.calls.update.length === 0 && /至少 6 位/.test(t.$('#rs-pwd-err').textContent));

  t.$('#rs-pwd').value = 'newpass123';
  t.$('#rs-pwd2').value = 'newpass124';
  t.submit(t.$('#form-reset'));
  await wait();
  check('A: 两次新密码不一致被拦下', t.calls.update.length === 0 && /不一致/.test(t.$('#rs-pwd2-err').textContent));

  t.$('#rs-pwd2').value = 'newpass123';
  t.submit(t.$('#form-reset'));
  await wait(30);
  check('A: 合法新密码调用 updateUser', t.calls.update.length === 1 && t.calls.update[0].password === 'newpass123');
  check('A: 改密成功给出提示', t.show('#reset-msg') && /已更新/.test(t.$('#reset-msg').textContent));

  /* 放弃改密 -> 退出登录态 */
  const t2 = boot('https://demo.example.com/game/');
  await wait(20);
  t2.fireAuth('PASSWORD_RECOVERY', { user: { email: 'me@example.com' } });
  await wait();
  t2.click(t2.$('#reset-cancel'));
  await wait();
  check('A: 「退出登录状态」调用 signOut', t2.calls.signOut.length === 1);
  t2.dom.window.close();

  /* 链接过期的 URL 兜底 */
  const t3 = boot('https://demo.example.com/game/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await wait(500);
  check('A: 链接过期时自动弹「重置密码」并给出原因',
    t3.show('#mask-forgot') && /过期/.test(t3.$('#forgot-msg').textContent),
    t3.$('#forgot-msg').textContent);
  t3.dom.window.close();

  check('A: 页面无运行时报错', t.hardErrors.length === 0, t.hardErrors.join(' | '));
  t.dom.window.close();

  /* ---------- 场景 B：本地 file:// 直接打开 ---------- */
  const f = boot('file:///Y:/qhDF/index.html');
  await wait(20);
  f.click(f.$('#btn-login'));
  await wait();
  f.click(f.$('#mask-login [data-auth-act="forgot"]'));
  await wait();
  check('B: file:// 下提示邮件链接会跳到线上站点',
    f.show('#forgot-msg') && /qhqiqi\.cn\/Delta-Force\//.test(f.$('#forgot-msg').textContent),
    f.$('#forgot-msg').textContent.slice(0, 40));
  f.$('#fg-email').value = 'me@example.com';
  f.submit(f.$('#form-forgot'));
  await wait(30);
  check('B: file:// 下仍能发出请求且 redirectTo 用线上地址',
    f.calls.reset.length === 1 && f.calls.reset[0].opts.redirectTo === 'https://qhqiqi.cn/Delta-Force/',
    f.calls.reset[0] && f.calls.reset[0].opts.redirectTo);
  check('B: 页面无运行时报错', f.hardErrors.length === 0, f.hardErrors.join(' | '));
  f.dom.window.close();

  /* ---------- 场景 C：就在线上站点打开 ---------- */
  const live = boot('https://qhqiqi.cn/Delta-Force/');
  await wait(20);
  live.click(live.$('#btn-login'));
  await wait();
  live.click(live.$('#mask-login [data-auth-act="forgot"]'));
  await wait();
  check('C: 已在站点地址上时不显示多余提示', !live.show('#forgot-msg'),
    live.$('#forgot-msg').textContent.slice(0, 40));
  live.dom.window.close();

  const failed = results.filter(r => !r.pass);
  results.forEach(r => console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : '')));
  console.log('\n通过 ' + (results.length - failed.length) + '/' + results.length);
  console.log(failed.length ? 'RESULT: FAIL' : 'RESULT: ALL PASS');
})();
