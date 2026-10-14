import { useEffect, useRef } from 'react';
import type { ChangeEvent } from 'react';
import type { ViewProps, WalletMode } from './types';

export function WalletPanel({ view, controller }: ViewProps) {
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const locked = view.busy || view.connected || view.pendingConnection;
  const mode = view.walletMode;
  const change = (name: 'savedAccount' | 'account' | 'accountLabel' | 'provider') => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => controller.setField(name, event.target.value);
  const connectLabel = mode === 'extension' ? `连接 ${view.providers[Number(view.provider)]?.name || 'Azguard'}`
    : mode === 'create' ? '创建并连接 DF 账号' : mode === 'import' ? '导入并连接 DF 账号' : '连接本地 Aztec 钱包';

  useEffect(() => {
    if (view.walletOpen) close.current?.focus();
    else if (wasOpen.current) menu.current?.focus();
    wasOpen.current = view.walletOpen;
  }, [view.walletOpen]);
  useEffect(() => {
    if (!view.walletOpen) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !view.busy) controller.setWalletPanel(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !view.busy) controller.setWalletPanel(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [view.walletOpen, view.busy, controller]);

  return <div className="wallet-anchor" ref={anchor}>
    <button id="walletMenu" ref={menu} type="button" disabled={view.busy}
      className={view.connected ? 'connected' : ''} aria-expanded={view.walletOpen} aria-controls="walletPanel"
      onClick={() => controller.setWalletPanel(!view.walletOpen)}>
      <span className="wallet-icon" aria-hidden="true">◈</span>
      <span id="walletMenuText">{view.address ? `${view.address.slice(0, 8)}…${view.address.slice(-6)}` : '连接钱包'}</span>
    </button>
    <section id="walletPanel" className="wallet-popover" aria-label="钱包连接" hidden={!view.walletOpen}>
      <div className="popover-head"><h2>钱包连接</h2><button id="walletClose" ref={close} type="button"
        aria-label="关闭钱包面板" disabled={view.busy} onClick={() => controller.setWalletPanel(false)}>×</button></div>
      <p className="small">与 DF 游戏一样，默认使用浏览器内置的 Aztec 钱包。本站与游戏不同源，游戏账号需要导出备份后在这里导入。</p>
      <label htmlFor="walletMode">连接方式</label>
      <select id="walletMode" value={mode} disabled={locked} onChange={event => controller.setField('walletMode', event.target.value as WalletMode)}>
        <option value="local">本地钱包 · 使用已保存账号</option>
        <option value="create">本地钱包 · 创建 DF 账号</option>
        <option value="import">本地钱包 · 导入 DF 账号备份</option>
        <option value="test">本地钱包 · 预置测试玩家（仅测试）</option>
        <option value="extension">Azguard · 扩展钱包（可选）</option>
      </select>
      <div id="localOptions" hidden={mode === 'extension'}>
        <div id="savedOptions" hidden={mode !== 'local'}>
          <label htmlFor="savedAccount">已保存的账号</label>
          <select id="savedAccount" value={view.savedAccount} disabled={locked} onChange={change('savedAccount')}>
            {!view.savedAccounts.length && <option value="">暂无账号，请创建或导入</option>}
            {view.savedAccounts.map(account => <option key={account.address} value={account.address}>
              {account.label || 'DF 账号'} · {account.address.slice(0, 10)}…{account.address.slice(-6)}
            </option>)}
          </select>
        </div>
        <div id="createOptions" hidden={mode !== 'create'}>
          <label htmlFor="accountLabel">账号名称（可选）</label>
          <input id="accountLabel" type="text" maxLength={32} placeholder="例如：本地玩家" disabled={locked}
            value={view.accountLabel} onChange={change('accountLabel')} />
          <p className="small">将在此浏览器创建 Schnorr 账号。密钥仅保存在本地浏览器且未加密；创建后请立即下载备份，不要在共享电脑使用。</p>
        </div>
        <div id="testOptions" hidden={mode !== 'test'}>
          <label htmlFor="account">测试玩家</label>
          <select id="account" value={view.account} disabled={locked} onChange={change('account')}>
            {view.accounts.map(account => <option key={account.value} value={account.value}>{account.label}</option>)}
          </select>
        </div>
        <div id="importOptions" hidden={mode !== 'import'}>
          <label htmlFor="accountFile">DF 导出的账号 JSON</label>
          <input key={view.fileVersion} id="accountFile" type="file" accept=".json,application/json" disabled={locked}
            onChange={event => controller.setField('accountFile', event.target.files?.[0] || null)} />
          <p className="small">文件只在浏览器中读取，不会上传。导入游戏账号不等于已在本站的独立 DF 测试链入局。</p>
        </div>
        <label className="check-label"><input id="realProofs" type="checkbox" checked={view.realProofs} disabled={locked}
          onChange={event => controller.setField('realProofs', event.target.checked)} />浏览器生成真实客户端证明（较慢）</label>
        <div id="localStatus" className="small" role="status" aria-live="polite">{view.localStatus}</div>
      </div>
      <div id="extensionOptions" hidden={mode !== 'extension'}>
        <p className="small">在安装 Azguard 的 Chrome 中打开，并将扩展切到 <code>{view.deployment?.nodeUrl || 'http://127.0.0.1:5180'}</code>。</p>
        <div className="row"><button id="scan" className="secondary" type="button" disabled={locked || !view.deployment}
          onClick={controller.scan}>重新扫描</button>
          <select id="provider" aria-label="Aztec 扩展钱包" hidden={view.providers.length < 2} disabled={locked}
            value={view.provider} onChange={change('provider')}>
            {view.providers.map((provider, index) => <option key={provider.id} value={String(index)}>{provider.name}</option>)}
          </select>
        </div>
        <div id="extensionStatus" className="small" role="status">{view.extensionStatus}</div>
        <div id="verification" hidden={!view.verification}>
          <p>确认以下表情与钱包中显示的一致：</p><div id="emoji">{view.emoji}</div>
          <div className="row"><button id="confirmWallet" type="button" disabled={view.busy || !view.pendingConnection}
            onClick={controller.confirmWallet}>表情一致，继续</button>
            <button id="cancelWallet" type="button" disabled={view.busy || !view.pendingConnection} onClick={controller.cancelWallet}>取消</button></div>
        </div>
        <div id="grantedAccountOptions" hidden={view.grantedAccounts.length < 2}>
          <label htmlFor="grantedAccount">已授权账号</label>
          <select id="grantedAccount" value={view.grantedAccount} disabled={view.busy}
            onChange={event => controller.selectGrantedAccount(event.target.value)}>
            {view.grantedAccounts.map(account => <option key={account.value} value={account.value}>{account.label}</option>)}
          </select>
        </div>
      </div>
      <button id="connect" type="button" disabled={locked || !view.deployment ||
        (mode === 'local' && !view.savedAccounts.length) || (mode === 'test' && !view.accounts.length)}
        onClick={controller.connect}>{connectLabel}</button>
      <div className="panel-address"><span>当前 Aztec 地址</span><span id="address" className="mono">{view.address || '未连接'}</span></div>
    </section>
  </div>;
}
