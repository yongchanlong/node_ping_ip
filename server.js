const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 数据库初始化
const db = new sqlite3.Database('hosts.db', (err) => {
    if (err) {
        console.error('连接数据库时出错:', err.message);
    } else {
        console.log('已连接到SQLite数据库');
        // 创建主机表
        db.run(`
            CREATE TABLE IF NOT EXISTS hosts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                ip TEXT NOT NULL,
                interval INTEGER NOT NULL,
                last_ping_time INTEGER,
                last_ping_success INTEGER,
                last_ping_time_ms REAL
            )
        `);
        
        // 创建历史记录表
        db.run(`
            CREATE TABLE IF NOT EXISTS ping_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                success INTEGER NOT NULL,
                time_ms REAL,
                FOREIGN KEY(host_id) REFERENCES hosts(id)
            )
        `);
    }
});

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API 路由
// 获取所有主机
app.get('/api/hosts', (req, res) => {
    db.all('SELECT * FROM hosts', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        const hosts = rows.map(row => ({
            id: row.id,
            name: row.name,
            ip: row.ip,
            interval: row.interval,
            lastPing: row.last_ping_time ? {
                timestamp: row.last_ping_time,
                success: row.last_ping_success === 1,
                time: row.last_ping_time_ms,
                pending: false
            } : null
        }));
        
        res.json(hosts);
    });
});

// 添加新主机
app.post('/api/hosts', (req, res) => {
    const { name, ip, interval } = req.body;
    
    if (!name || !ip || !interval) {
        res.status(400).json({ error: '缺少必要的参数' });
        return;
    }
    
    db.run(
        'INSERT INTO hosts (name, ip, interval) VALUES (?, ?, ?)',
        [name, ip, interval],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            const host = {
                id: this.lastID,
                name,
                ip,
                interval,
                lastPing: null
            };
            
            // 通知所有客户端主机列表已更新
            broadcast({ type: 'hostsUpdated' });
            
            res.status(201).json(host);
        }
    );
});

// 更新主机
app.put('/api/hosts/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { name, ip, interval } = req.body;
    
    if (!name || !ip || !interval) {
        res.status(400).json({ error: '缺少必要的参数' });
        return;
    }
    
    db.run(
        'UPDATE hosts SET name = ?, ip = ?, interval = ? WHERE id = ?',
        [name, ip, interval, id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            if (this.changes === 0) {
                res.status(404).json({ error: '未找到主机' });
                return;
            }
            
            // 通知所有客户端主机列表已更新
            broadcast({ type: 'hostsUpdated' });
            
            res.json({ message: '主机更新成功' });
        }
    );
});

// 删除主机
app.delete('/api/hosts/:id', (req, res) => {
    const id = parseInt(req.params.id);
    
    db.run(
        'DELETE FROM hosts WHERE id = ?',
        [id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            if (this.changes === 0) {
                res.status(404).json({ error: '未找到主机' });
                return;
            }
            
            // 删除相关历史记录
            db.run('DELETE FROM ping_history WHERE host_id = ?', [id]);
            
            // 通知所有客户端主机列表已更新
            broadcast({ type: 'hostsUpdated' });
            
            res.json({ message: '主机删除成功' });
        }
    );
});

// 获取历史记录
app.get('/api/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    
    db.all(
        `SELECT h.name as hostName, h.ip as hostIp, ph.* 
         FROM ping_history ph 
         JOIN hosts h ON ph.host_id = h.id 
         ORDER BY ph.timestamp DESC 
         LIMIT ?`,
        [limit],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            const history = rows.map(row => ({
                id: row.id,
                hostId: row.host_id,
                hostName: row.hostName,
                hostIp: row.hostIp,
                success: row.success === 1,
                timestamp: row.timestamp,
                time: row.time_ms
            }));
            
            res.json(history);
        }
    );
});

// 首页路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket 连接处理
wss.on('connection', (ws) => {
    console.log('客户端已连接');
    
    // 发送初始主机数据
    db.all('SELECT * FROM hosts', (err, rows) => {
        if (err) {
            console.error('获取主机数据时出错:', err.message);
            return;
        }
        
        const hosts = rows.map(row => ({
            id: row.id,
            name: row.name,
            ip: row.ip,
            interval: row.interval,
            lastPing: row.last_ping_time ? {
                timestamp: row.last_ping_time,
                success: row.last_ping_success === 1,
                time: row.last_ping_time_ms,
                pending: false
            } : null
        }));
        
        ws.send(JSON.stringify({ type: 'initialHosts', hosts }));
    });
    
    ws.on('close', () => {
        console.log('客户端已断开连接');
    });
});

// 广播消息给所有客户端
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// 定期Ping主机
function schedulePings() {
    // 立即执行一次
    pingAllHosts();
    
    // 每5秒检查一次是否有主机需要ping
    setInterval(pingAllHosts, 5000);
}

// Ping所有需要ping的主机
function pingAllHosts() {
    const now = Date.now();
    
    db.all('SELECT * FROM hosts', (err, rows) => {
        if (err) {
            console.error('获取主机数据时出错:', err.message);
            return;
        }
        
        rows.forEach(host => {
            // 计算下一次ping时间
            const nextPingTime = (host.last_ping_time || 0) + (host.interval * 1000);
            
            // 如果到了ping时间或者还没有ping过
            if (now >= nextPingTime || !host.last_ping_time) {
                // 标记为正在ping
                const hostData = {
                    id: host.id,
                    name: host.name,
                    ip: host.ip,
                    interval: host.interval,
                    lastPing: {
                        timestamp: now,
                        pending: true
                    }
                };
                
                // 通知客户端正在ping
                broadcast({ type: 'pingResult', host: hostData });
                
                // 执行ping
                pingHost(host.ip, (success, time) => {
                    const pingTime = Date.now();
                    
                    // 更新数据库
                    db.run(
                        'UPDATE hosts SET last_ping_time = ?, last_ping_success = ?, last_ping_time_ms = ? WHERE id = ?',
                        [pingTime, success ? 1 : 0, time, host.id],
                        (err) => {
                            if (err) {
                                console.error('更新主机ping状态时出错:', err.message);
                                return;
                            }
                            
                            // 更新历史记录
                            db.run(
                                'INSERT INTO ping_history (host_id, timestamp, success, time_ms) VALUES (?, ?, ?, ?)',
                                [host.id, pingTime, success ? 1 : 0, time],
                                (err) => {
                                    if (err) {
                                        console.error('记录ping历史时出错:', err.message);
                                    }
                                }
                            );
                            
                            // 更新主机数据
                            const updatedHost = {
                                id: host.id,
                                name: host.name,
                                ip: host.ip,
                                interval: host.interval,
                                lastPing: {
                                    timestamp: pingTime,
                                    success,
                                    time,
                                    pending: false
                                }
                            };
                            
                            // 通知客户端ping结果
                            broadcast({ type: 'pingResult', host: updatedHost });
                        }
                    );
                });
            }
        });
    });
}

// 执行ping命令
function pingHost(ip, callback) {
    const start = process.hrtime();
    
    // 根据操作系统选择合适的ping命令
    const cmd = process.platform === 'win32' 
        ? `ping -n 1 -w 1000 ${ip}` 
        : `ping -c 1 -W 1 ${ip}`;
    
    exec(cmd, (error, stdout, stderr) => {
        const end = process.hrtime(start);
        const time = Math.round((end[0] * 1000) + (end[1] / 1000000));
        
        // 判断ping是否成功
        let success = false;
        
        if (process.platform === 'win32') {
            // Windows系统
            success = !error && stdout.includes('TTL=');
        } else {
            // Linux/macOS系统
            success = !error && stdout.includes('1 packets transmitted, 1 received');
        }
        
        callback(success, success ? time : null);
    });
}

// 启动服务器
server.listen(3000, () => {
    console.log('服务器运行在 http://localhost:3000');
    // 启动定期ping
    schedulePings();
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('正在关闭服务器...');
    db.close();
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});
    