// ==UserScript==
// @name         B站动态分组筛选助手 v5.0
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  在B站动态页面按关注分组筛选动态（持久化存储版）
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

    // ==================== 全局变量 ====================
    let groups = [];
    let groupMembers = {};
    let currentGroupId = GM_getValue('currentGroupId', null);
    let currentGroupMemberSet = null;
    let panelVisible = false;
    let filterStats = { total: 0, shown: 0 };
    let isReady = false;

    // ==================== 初始化加载已保存的分组成员 ====================
    async function initSavedGroup() {
        if (currentGroupId) {
            console.log(`[分组筛选] 检测到已保存的分组ID: ${currentGroupId}，正在加载成员...`);
            const members = await getGroupMembersSync(currentGroupId);
            if (members && members.length > 0) {
                currentGroupMemberSet = new Set(members);
                console.log(`[分组筛选] 分组成员加载完成，共 ${members.length} 人`);
            } else {
                console.log(`[分组筛选] 分组成员加载失败或为空`);
                currentGroupId = null;
                currentGroupMemberSet = null;
                GM_setValue('currentGroupId', null);
            }
        }
        isReady = true;
    }

    // 同步获取分组成员（使用Promise等待）
    function getGroupMembersSync(tagId) {
        return new Promise((resolve) => {
            // 先检查缓存
            const cached = GM_getValue(`members_${tagId}`, null);
            if (cached && cached.length > 0) {
                groupMembers[tagId] = cached;
                resolve(cached);
                return;
            }

            const allMembers = [];
            let currentPage = 1;

            function fetchPage() {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.bilibili.com/x/relation/tag?tagid=${tagId}&pn=${currentPage}&ps=50`,
                    withCredentials: true,
                    headers: { 'Referer': 'https://t.bilibili.com/' },
                    onload: function(response) {
                        try {
                            const data = JSON.parse(response.responseText);
                            if (data.code === 0 && data.data && data.data.length > 0) {
                                data.data.forEach(user => allMembers.push(user.mid));
                                if (data.data.length === 50) {
                                    currentPage++;
                                    setTimeout(fetchPage, 50);
                                } else {
                                    groupMembers[tagId] = allMembers;
                                    GM_setValue(`members_${tagId}`, allMembers);
                                    resolve(allMembers);
                                }
                            } else {
                                groupMembers[tagId] = allMembers;
                                if (allMembers.length > 0) {
                                    GM_setValue(`members_${tagId}`, allMembers);
                                }
                                resolve(allMembers);
                            }
                        } catch (e) { 
                            resolve(allMembers); 
                        }
                    },
                    onerror: () => resolve(allMembers)
                });
            }
            fetchPage();
        });
    }

    // ==================== API 拦截（在初始化完成后生效） ====================
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0]?.url || args[0];

        // 拦截动态列表API
        if (typeof url === 'string' && url.includes('/x/polymer/web-dynamic/v1/feed/all')) {
            // 等待初始化完成
            if (!isReady) {
                await new Promise(resolve => {
                    const check = setInterval(() => {
                        if (isReady) {
                            clearInterval(check);
                            resolve();
                        }
                    }, 50);
                });
            }

            if (currentGroupMemberSet && currentGroupMemberSet.size > 0) {
                const clone = response.clone();
                try {
                    const data = await clone.json();
                    if (data.code === 0 && data.data && data.data.items) {
                        const originalCount = data.data.items.length;
                        
                        // 筛选属于当前分组的动态
                        data.data.items = data.data.items.filter(item => {
                            const mid = item?.modules?.module_author?.mid;
                            return mid && currentGroupMemberSet.has(mid);
                        });

                        const filteredCount = data.data.items.length;
                        filterStats.total += originalCount;
                        filterStats.shown += filteredCount;
                        
                        console.log(`[分组筛选] API拦截成功: ${originalCount} -> ${filteredCount}`);

                        // 返回修改后的响应
                        return new Response(JSON.stringify(data), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    }
                } catch (e) {
                    console.error('[分组筛选] 处理响应失败:', e);
                }
            }
        }
        return response;
    };

    // 立即开始初始化
    initSavedGroup();

    // ==================== 样式 ====================
    GM_addStyle(`
        .gf-container {
            position: fixed;
            top: 70px;
            right: 20px;
            z-index: 99999;
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            padding: 15px;
            min-width: 250px;
            max-height: 70vh;
            overflow-y: auto;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: none;
        }
        .gf-container::-webkit-scrollbar { width: 6px; }
        .gf-container::-webkit-scrollbar-thumb { background: #ddd; border-radius: 3px; }
        .gf-title {
            font-weight: bold;
            font-size: 15px;
            margin-bottom: 12px;
            color: #00a1d6;
            border-bottom: 2px solid #00a1d6;
            padding-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .gf-item {
            padding: 10px 14px;
            margin: 6px 0;
            cursor: pointer;
            border-radius: 8px;
            transition: all 0.2s ease;
            font-size: 14px;
            background: #f5f5f5;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .gf-item:hover { background: #e3f2fd; transform: translateX(3px); }
        .gf-item.active {
            background: linear-gradient(135deg, #00a1d6, #00b5e5);
            color: #fff;
            box-shadow: 0 2px 8px rgba(0,161,214,0.4);
        }
        .gf-item .count { font-size: 12px; opacity: 0.8; }
        .gf-btn {
            position: fixed;
            top: 70px;
            right: 20px;
            z-index: 100000;
            background: linear-gradient(135deg, #00a1d6, #00b5e5);
            color: #fff;
            border: none;
            padding: 12px 18px;
            border-radius: 25px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            box-shadow: 0 4px 15px rgba(0,161,214,0.4);
            transition: all 0.3s ease;
        }
        .gf-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,161,214,0.5); }
        .gf-btn.filtering { background: linear-gradient(135deg, #ff9800, #ffb74d); }
        .gf-close { cursor: pointer; font-size: 18px; color: #999; transition: color 0.2s; }
        .gf-close:hover { color: #ff6b6b; }
        .gf-status {
            font-size: 12px;
            color: #666;
            padding: 8px 0;
            border-top: 1px solid #eee;
            margin-top: 10px;
            text-align: center;
        }
        .gf-tip {
            font-size: 12px;
            color: #666;
            padding: 10px;
            background: #e8f5e9;
            border-radius: 6px;
            margin-top: 10px;
            line-height: 1.6;
        }
        .gf-tip.warning {
            background: #fff3e0;
        }
        .gf-loading {
            text-align: center;
            padding: 20px;
            color: #999;
        }
        .gf-current {
            font-size: 12px;
            color: #ff9800;
            padding: 8px 10px;
            background: #fff3e0;
            border-radius: 6px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .gf-clear-btn {
            background: #ff5722;
            color: #fff;
            border: none;
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .gf-clear-btn:hover {
            background: #e64a19;
        }
    `);

    // ==================== UI 创建 ====================
    function createUI() {
        // 切换按钮
        const btn = document.createElement('button');
        btn.className = 'gf-btn';
        btn.id = 'gf-toggle-btn';
        
        // 根据是否有筛选状态设置按钮样式
        if (currentGroupId) {
            btn.classList.add('filtering');
            btn.innerHTML = '🔍 筛选中...';
        } else {
            btn.innerHTML = '📁 分组筛选';
        }
        document.body.appendChild(btn);

        // 面板
        const panel = document.createElement('div');
        panel.className = 'gf-container';
        panel.id = 'gf-panel';
        panel.innerHTML = '<div class="gf-loading">加载中...</div>';
        document.body.appendChild(panel);

        btn.addEventListener('click', () => {
            panelVisible = !panelVisible;
            panel.style.display = panelVisible ? 'block' : 'none';
            btn.style.display = panelVisible ? 'none' : 'block';
            if (panelVisible && groups.length === 0) {
                loadGroups();
            }
        });
    }

    // ==================== 加载分组列表 ====================
    function loadGroups() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://api.bilibili.com/x/relation/tags',
            withCredentials: true,
            headers: { 'Referer': 'https://t.bilibili.com/' },
            onload: function(response) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.code === 0 && data.data) {
                        groups = data.data;
                        renderPanel();
                    } else {
                        document.getElementById('gf-panel').innerHTML = 
                            '<div class="gf-loading">⚠️ 获取分组失败，请确保已登录B站</div>';
                    }
                } catch (e) {
                    document.getElementById('gf-panel').innerHTML = 
                        '<div class="gf-loading">⚠️ 数据解析错误</div>';
                }
            },
            onerror: () => {
                document.getElementById('gf-panel').innerHTML = 
                    '<div class="gf-loading">⚠️ 网络错误</div>';
            }
        });
    }

    // ==================== 面板渲染 ====================
    function renderPanel() {
        const panel = document.getElementById('gf-panel');
        const savedGroupName = GM_getValue('currentGroupName', '');
        
        let html = `
            <div class="gf-title">
                <span>📁 关注分组筛选</span>
                <span class="gf-close" id="gf-close">✕</span>
            </div>
        `;

        // 显示当前筛选状态
        if (currentGroupId && savedGroupName) {
            html += `
                <div class="gf-current">
                    <span>🔍 当前筛选：<strong>${savedGroupName}</strong></span>
                    <button class="gf-clear-btn" id="gf-clear">取消</button>
                </div>
            `;
        }

        html += `
            <div class="gf-item ${!currentGroupId ? 'active' : ''}" data-id="all">
                <span>📺 显示全部动态</span>
            </div>
        `;
        
        groups.forEach(g => {
            html += `
                <div class="gf-item ${currentGroupId === g.tagid ? 'active' : ''}" data-id="${g.tagid}" data-name="${g.name}">
                    <span>📂 ${g.name}</span>
                    <span class="count">${g.count}人</span>
                </div>
            `;
        });
        
        html += `
            <div class="gf-status" id="gf-status">
                ${currentGroupId ? `筛选生效中，已显示 ${filterStats.shown} 条` : '点击分组开始筛选'}
            </div>
            <div class="gf-tip">
                💡 <strong>使用说明：</strong><br>
                1. 选择一个分组<br>
                2. 点击下方「刷新页面」按钮<br>
                3. 筛选设置会自动保存，持续生效
            </div>
            <button id="gf-refresh-btn" style="
                width: 100%;
                margin-top: 10px;
                padding: 12px;
                background: linear-gradient(135deg, #4caf50, #66bb6a);
                color: #fff;
                border: none;
                border-radius: 8px;
                font-size: 14px;
                cursor: pointer;
                font-weight: 500;
            ">🔄 刷新页面应用筛选</button>
        `;
        panel.innerHTML = html;

        // 绑定关闭事件
        document.getElementById('gf-close').addEventListener('click', () => {
            panelVisible = false;
            panel.style.display = 'none';
            document.getElementById('gf-toggle-btn').style.display = 'block';
        });

        // 绑定取消筛选按钮
        const clearBtn = document.getElementById('gf-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                clearFilter();
            });
        }

        // 绑定刷新按钮
        document.getElementById('gf-refresh-btn').addEventListener('click', () => {
            location.reload();
        });

        // 绑定分组点击事件
        panel.querySelectorAll('.gf-item').forEach(item => {
            item.addEventListener('click', async () => {
                const tagId = item.dataset.id;
                const tagName = item.dataset.name || '';
                
                // 更新选中状态
                panel.querySelectorAll('.gf-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');

                if (tagId === 'all') {
                    clearFilter();
                } else {
                    await selectGroup(parseInt(tagId), tagName);
                }
            });
        });
    }

    // 选择分组
    async function selectGroup(tagId, tagName) {
        const statusEl = document.getElementById('gf-status');
        if (statusEl) statusEl.textContent = '正在加载分组成员...';

        const members = await getGroupMembersSync(tagId);
        
        if (members.length === 0) {
            if (statusEl) statusEl.textContent = '⚠️ 该分组没有成员';
            return;
        }

        // 保存到持久化存储
        currentGroupId = tagId;
        currentGroupMemberSet = new Set(members);
        GM_setValue('currentGroupId', tagId);
        GM_setValue('currentGroupName', tagName);
        
        console.log(`[分组筛选] 已选择分组: ${tagName}, 成员数: ${members.length}`);
        
        // 更新UI
        const btn = document.getElementById('gf-toggle-btn');
        btn.classList.add('filtering');
        btn.innerHTML = `🔍 ${tagName}`;
        
        if (statusEl) {
            statusEl.textContent = `已选择「${tagName}」(${members.length}人)，请点击下方按钮刷新页面`;
        }

        // 重新渲染面板显示当前状态
        renderPanel();
    }

    // 清除筛选
    function clearFilter() {
        currentGroupId = null;
        currentGroupMemberSet = null;
        filterStats = { total: 0, shown: 0 };
        
        GM_setValue('currentGroupId', null);
        GM_setValue('currentGroupName', '');
        
        const btn = document.getElementById('gf-toggle-btn');
        btn.classList.remove('filtering');
        btn.innerHTML = '📁 分组筛选';
        
        const statusEl = document.getElementById('gf-status');
        if (statusEl) {
            statusEl.textContent = '已取消筛选，请刷新页面查看全部动态';
        }

        // 重新渲染面板
        renderPanel();
    }

    // ==================== 初始化 ====================
    function init() {
        if (document.body) {
            createUI();
            // 如果有已保存的分组，更新按钮状态
            if (currentGroupId) {
                const groupName = GM_getValue('currentGroupName', '筛选中');
                const btn = document.getElementById('gf-toggle-btn');
                if (btn) {
                    btn.classList.add('filtering');
                    btn.innerHTML = `🔍 ${groupName}`;
                }
            }
            console.log('[分组筛选] v5.0 持久化存储版已加载');
        } else {
            document.addEventListener('DOMContentLoaded', init);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 0);
    }

})();
