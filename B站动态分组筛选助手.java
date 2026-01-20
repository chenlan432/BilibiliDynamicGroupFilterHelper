// ==UserScript==
// @name         B站动态分组筛选助手 v16.1
// @namespace    http://tampermonkey.net/
// @version      16.1
// @description  在B站动态页面按关注分组筛选动态
// @author       You
// @match        https://t.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    let groups = [];
    let currentGroupId = GM_getValue('currentGroupId', null);
    let currentGroupMemberSet = null;
    let panelVisible = false;
    let filterStats = { total: 0, shown: 0 };
    let isReady = false;
    let hasMore = true;
    let isLoading = false;
    let emptyCount = 0;

    const log = (...args) => console.log('[分组筛选]', ...args);

    // ========== 初始化 ==========
    async function init() {
        if (currentGroupId) {
            log(`加载分组: ${currentGroupId}`);
            const members = await fetchMembers(currentGroupId);
            if (members?.length) {
                currentGroupMemberSet = new Set(members.map(String));
                log(`成员数: ${members.length}`);
            } else {
                currentGroupId = null;
                GM_setValue('currentGroupId', null);
            }
        }
        isReady = true;
    }

    function fetchMembers(tagId) {
        return new Promise(resolve => {
            const cached = GM_getValue(`m_${tagId}`, null);
            const time = GM_getValue(`t_${tagId}`, 0);
            if (cached?.length && Date.now() - time < 3600000) {
                return resolve(cached);
            }
            const all = [];
            let p = 1;
            const get = () => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.bilibili.com/x/relation/tag?tagid=${tagId}&pn=${p}&ps=50`,
                    withCredentials: true,
                    onload: r => {
                        try {
                            const d = JSON.parse(r.responseText);
                            if (d.code === 0 && d.data) {
                                d.data.forEach(u => all.push(String(u.mid)));
                                if (d.data.length === 50) { p++; setTimeout(get, 30); }
                                else {
                                    GM_setValue(`m_${tagId}`, all);
                                    GM_setValue(`t_${tagId}`, Date.now());
                                    resolve(all);
                                }
                            } else resolve(all);
                        } catch { resolve(all); }
                    },
                    onerror: () => resolve(all)
                });
            };
            get();
        });
    }

    // ========== 触发滚动 ==========
    function triggerScroll() {
        if (isLoading) return;
        isLoading = true;
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        setTimeout(() => { isLoading = false; }, 150);
    }

    // ========== API拦截 ==========
    const _fetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
        const res = await _fetch.apply(this, args);
        const url = args[0]?.url || args[0];

        if (typeof url === 'string' && url.includes('/x/polymer/web-dynamic/v1/feed/all')) {
            if (!isReady) await new Promise(r => { const c = setInterval(() => { if (isReady) { clearInterval(c); r(); } }, 30); });

            if (currentGroupMemberSet?.size) {
                try {
                    const clone = res.clone();
                    const data = await clone.json();

                    if (data.code === 0 && data.data) {
                        const items = data.data.items || [];
                        const origLen = items.length;
                        hasMore = data.data.has_more;

                        // 筛选匹配的动态
                        const filtered = items.filter(item => {
                            const mid = String(item?.modules?.module_author?.mid || '');
                            return mid && currentGroupMemberSet.has(mid);
                        });

                        filterStats.total += origLen;
                        filterStats.shown += filtered.length;

                        log(`过滤: ${origLen} -> ${filtered.length}, hasMore: ${hasMore}`);

                        // 核心策略：筛选后为空但还有更多数据时，保留占位项并自动加载
                        if (filtered.length === 0 && hasMore && items.length > 0) {
                            emptyCount++;
                            // 保留一个占位项（会显示但马上被下一批数据覆盖）
                            const placeholder = JSON.parse(JSON.stringify(items[0]));
                            data.data.items = [placeholder];
                            
                            // 自动触发加载下一页
                            const delay = Math.min(100 + emptyCount * 10, 500);
                            setTimeout(triggerScroll, delay);
                            
                            showLoading(true);
                        } else {
                            data.data.items = filtered;
                            if (filtered.length > 0) emptyCount = 0;
                            showLoading(false);
                        }

                        if (!hasMore) {
                            showLoading(false);
                            log('已到达数据末尾');
                        }

                        updateUI();

                        return new Response(JSON.stringify(data), {
                            status: res.status,
                            statusText: res.statusText,
                            headers: res.headers
                        });
                    }
                } catch (e) {
                    console.error('[分组筛选]', e);
                }
            }
        }
        return res;
    };

    init();

    // ========== 样式 ==========
    GM_addStyle(`
        .gf-p{position:fixed;top:70px;right:20px;z-index:99999;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:15px;width:280px;max-height:75vh;overflow-y:auto;display:none;font-family:system-ui,sans-serif}
        .gf-t{font-weight:700;font-size:15px;color:#00a1d6;border-bottom:2px solid #00a1d6;padding-bottom:10px;margin-bottom:12px;display:flex;justify-content:space-between}
        .gf-x{cursor:pointer;color:#999}.gf-x:hover{color:red}
        .gf-c{background:#fff3e0;padding:8px 10px;border-radius:6px;margin-bottom:10px;font-size:12px;display:flex;justify-content:space-between;align-items:center}
        .gf-i{padding:10px 12px;margin:5px 0;background:#f5f5f5;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;font-size:14px;transition:.2s}
        .gf-i:hover{background:#e3f2fd}.gf-i.on{background:#00a1d6;color:#fff}
        .gf-s{font-size:12px;color:#666;text-align:center;padding:8px 0;border-top:1px solid #eee;margin-top:10px}
        .gf-b{width:100%;padding:10px;margin-top:8px;border:none;border-radius:8px;color:#fff;font-size:13px;cursor:pointer}
        .gf-b:hover{opacity:.9}.gf-g{background:linear-gradient(135deg,#4caf50,#66bb6a)}.gf-o{background:linear-gradient(135deg,#ff9800,#ffb74d)}
        .gf-cb{background:#ff5722;padding:4px 10px;font-size:12px;border-radius:4px;border:none;color:#fff;cursor:pointer}
        .gf-tip{font-size:11px;color:#888;margin-top:10px;line-height:1.5;background:#f9f9f9;padding:8px;border-radius:6px}
        .gf-btn{position:fixed;top:70px;right:20px;z-index:100000;background:linear-gradient(135deg,#00a1d6,#00b5e5);color:#fff;border:none;padding:12px 18px;border-radius:25px;cursor:pointer;font-size:14px;box-shadow:0 4px 15px rgba(0,161,214,.4)}
        .gf-btn:hover{transform:translateY(-2px)}.gf-btn.on{background:linear-gradient(135deg,#ff9800,#ffb74d)}
        .gf-ld{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;z-index:99999;display:none}
    `);

    // ========== UI ==========
    function createUI() {
        const btn = document.createElement('button');
        btn.className = 'gf-btn' + (currentGroupId ? ' on' : '');
        btn.id = 'gf-btn';
        btn.textContent = currentGroupId ? `🔍 ${GM_getValue('currentGroupName', '')}` : '📁 分组筛选';
        document.body.appendChild(btn);

        const panel = document.createElement('div');
        panel.className = 'gf-p';
        panel.id = 'gf-p';
        document.body.appendChild(panel);

        const ld = document.createElement('div');
        ld.className = 'gf-ld';
        ld.id = 'gf-ld';
        ld.textContent = '🔄 正在加载更多历史动态...';
        document.body.appendChild(ld);

        btn.onclick = () => {
            panelVisible = !panelVisible;
            panel.style.display = panelVisible ? 'block' : 'none';
            btn.style.display = panelVisible ? 'none' : 'block';
            if (panelVisible && !groups.length) loadGroups();
        };
    }

    function showLoading(show) {
        const ld = document.getElementById('gf-ld');
        if (ld) ld.style.display = show ? 'block' : 'none';
    }

    function loadGroups() {
        const p = document.getElementById('gf-p');
        p.innerHTML = '<div style="text-align:center;padding:20px;color:#999">加载中...</div>';
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://api.bilibili.com/x/relation/tags',
            withCredentials: true,
            onload: r => {
                try {
                    const d = JSON.parse(r.responseText);
                    if (d.code === 0 && d.data) { groups = d.data; render(); }
                    else p.innerHTML = '<div style="color:red;padding:20px">获取失败，请确保已登录</div>';
                } catch { p.innerHTML = '<div style="color:red;padding:20px">解析错误</div>'; }
            }
        });
    }

    function render() {
        const p = document.getElementById('gf-p');
        const name = GM_getValue('currentGroupName', '');
        let h = `<div class="gf-t"><span>📁 分组筛选</span><span class="gf-x" id="gf-x">✕</span></div>`;
        if (currentGroupId && name) h += `<div class="gf-c"><span>🔍 ${name}</span><button class="gf-cb" id="gf-cl">取消</button></div>`;
        h += `<div class="gf-i ${!currentGroupId?'on':''}" data-id="all"><span>📺 全部动态</span></div>`;
        groups.forEach(g => h += `<div class="gf-i ${currentGroupId===g.tagid?'on':''}" data-id="${g.tagid}" data-n="${g.name}"><span>📂 ${g.name}</span><span style="font-size:12px;opacity:.7">${g.count}</span></div>`);
        h += `<div class="gf-s" id="gf-s">${currentGroupId ? `显示 ${filterStats.shown} 条` : '选择分组开始筛选'}</div>`;
        h += `<button class="gf-b gf-g" id="gf-r">🔄 刷新页面</button>`;
        h += `<button class="gf-b gf-o" id="gf-cc">🗑️ 清除缓存</button>`;
        h += `<div class="gf-tip">💡 选择分组后刷新页面，向下滚动会自动加载更多历史动态</div>`;
        p.innerHTML = h;

        document.getElementById('gf-x').onclick = () => {
            panelVisible = false;
            p.style.display = 'none';
            document.getElementById('gf-btn').style.display = 'block';
        };
        document.getElementById('gf-r').onclick = () => location.reload();
        document.getElementById('gf-cc').onclick = () => {
            groups.forEach(g => { GM_setValue(`m_${g.tagid}`, null); GM_setValue(`t_${g.tagid}`, 0); });
            alert('缓存已清除'); location.reload();
        };
        const cl = document.getElementById('gf-cl');
        if (cl) cl.onclick = clear;
        p.querySelectorAll('.gf-i').forEach(i => i.onclick = () => {
            const id = i.dataset.id;
            id === 'all' ? clear() : select(+id, i.dataset.n);
        });
    }

    function updateUI() {
        const s = document.getElementById('gf-s');
        if (s && currentGroupId) {
            s.textContent = `显示 ${filterStats.shown} 条，过滤 ${filterStats.total - filterStats.shown} 条`;
        }
    }

    async function select(id, name) {
        const s = document.getElementById('gf-s');
        if (s) s.textContent = '加载分组成员...';
        GM_setValue(`m_${id}`, null);
        GM_setValue(`t_${id}`, 0);
        const m = await fetchMembers(id);
        if (!m?.length) { if (s) s.textContent = '该分组没有成员'; return; }
        
        currentGroupId = id;
        currentGroupMemberSet = new Set(m.map(String));
        filterStats = { total: 0, shown: 0 };
        hasMore = true;
        emptyCount = 0;
        
        GM_setValue('currentGroupId', id);
        GM_setValue('currentGroupName', name);
        
        const btn = document.getElementById('gf-btn');
        btn.className = 'gf-btn on';
        btn.textContent = `🔍 ${name}`;
        
        render();
    }

    function clear() {
        currentGroupId = null;
        currentGroupMemberSet = null;
        filterStats = { total: 0, shown: 0 };
        emptyCount = 0;
        
        GM_setValue('currentGroupId', null);
        GM_setValue('currentGroupName', '');
        
        const btn = document.getElementById('gf-btn');
        btn.className = 'gf-btn';
        btn.textContent = '📁 分组筛选';
        
        showLoading(false);
        render();
    }

    // ========== 启动 ==========
    if (document.body) { createUI(); log('v16.1 已加载'); }
    else document.addEventListener('DOMContentLoaded', () => { createUI(); log('v16.1 已加载'); });
})();
