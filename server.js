const express = require('express');
const fs = require('fs').promises;
const pino = require('pino');
const NodeCache = require('node-cache');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('baileys');
const { createClient } = require('@supabase/supabase-js');
const { Mutex } = require('async-mutex');
const axios = require('axios');
const config = require('./config');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = config.PORT || 7860;
const msgRetryCounterCache = new NodeCache();
const mutex = new Mutex();

// Initialize Supabase client with error handling
let supabase;
try {
    supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);
} catch (error) {
    console.error('Supabase initialization failed:', error.message);
    process.exit(1);
}

app.use(express.static(path.join(__dirname, 'public')));

// Dashboard signal function (unchanged as requested)
async function sendDashboardSignal(type) {
    try {
        const dashboardUrl = 'https://king-xer-ai.zone.id';
        const response = await axios.post(`${dashboardUrl}/signal`, {
            type
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.status !== 200) {
            console.error('Failed to send dashboard signal');
        }
    } catch (error) {
        console.error('Error sending dashboard signal:', error.message);
    }
}

// Session management utilities
class SessionManager {
    constructor() {
        this.baseDir = './temp_session';
    }

    async ensureSessionDir() {
        try {
            await fs.access(this.baseDir);
        } catch {
            await fs.mkdir(this.baseDir, { recursive: true });
        }
    }

    async cleanupSessionDir() {
        try {
            await fs.rm(this.baseDir, { recursive: true, force: true });
        } catch (error) {
            console.error('Session cleanup error:', error.message);
        }
    }

    async uploadSession() {
        try {
            const files = await fs.readdir(this.baseDir);
            const sessionId = crypto.randomBytes(8).toString('hex');
            
            for (const file of files) {
                const filePath = path.join(this.baseDir, file);
                const fileContent = await fs.readFile(filePath);
                
                const { error } = await supabase.storage
                    .from('session')
                    .upload(`${sessionId}/${file}`, fileContent);
                
                if (error) throw error;
            }
            
            return sessionId;
        } catch (error) {
            console.error('Supabase upload error:', error.message);
            throw error;
        }
    }
}

// WhatsApp connection handler
class WhatsAppConnector {
    constructor() {
        this.sessionManager = new SessionManager();
        this.session = null;
    }

    async initialize(phoneNumber, res) {
        await this.sessionManager.ensureSessionDir();
        
        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.sessionManager.baseDir);
            const { version } = await fetchLatestBaileysVersion();

            this.session = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
                },
                logger: pino({ level: 'silent' }),
                browser: Browsers.macOS("Safari"),
                version,
                markOnlineOnConnect: true,
                msgRetryCounterCache
            });

            this.session.ev.on('creds.update', saveCreds);

            if (!this.session.authState.creds.registered) {
                await delay(1500);
                const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                
                try {
                    const code = await this.session.requestPairingCode(cleanNumber);
                    if (!res.headersSent) {
                        res.send({ code: code?.match(/.{1,4}/g)?.join('-') });
                    }
                } catch (error) {
                    console.error('Pairing code request error:', error.message);
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            success: false,
                            error: 'Failed to generate pairing code'
                        });
                    }
                    return;
                }
            }

            this.setupConnectionHandlers(res);
        } catch (error) {
            console.error('Connector initialization error:', error.message);
            if (!res.headersSent) {
                res.status(500).json({ 
                    success: false,
                    error: 'Connection failed',
                    details: error.message
                });
            }
            await this.sessionManager.cleanupSessionDir();
        }
    }

    setupConnectionHandlers(res) {
        this.session.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log('Connected successfully');
                await delay(3000); // Reduced delay
                
                try {
                    const sessionId = await this.sessionManager.uploadSession();
                    const sID = config.PREFIX + sessionId;
                    
                    await this.session.sendMessage(this.session.user.id, { 
                        text: `*Session ID*\n\n${sID}\n\nDo not share this with anyone!` 
                    });
                    
                    await sendDashboardSignal('paircode');
                } catch (error) {
                    console.error('Session finalization error:', error.message);
                } finally {
                    await this.sessionManager.cleanupSessionDir();
                    this.cleanup();
                }
            } else if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    console.log('Logged out, please restart the server');
                    this.cleanup();
                    await this.sessionManager.cleanupSessionDir();
                } else {
                    console.log('Connection lost, cleaning up');
                    this.cleanup();
                    await this.sessionManager.cleanupSessionDir();
                }
            }
        });
    }

    cleanup() {
        if (this.session) {
            this.session.end();
            this.session = null;
        }
    }
}

// Pairing endpoint
app.get('/pair', async (req, res) => {
    const phoneNumber = req.query.number;
    if (!phoneNumber) {
        return res.status(400).json({ 
            success: false,
            error: 'Phone number is required'
        });
    }
  
    const release = await mutex.acquire();
    try {
        const connector = new WhatsAppConnector();
        await connector.initialize(phoneNumber, res);
    } catch (error) {
        console.error('Pairing error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false,
                error: 'Failed to generate pairing code',
                details: error.message
            });
        }
    } finally {
        release();
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Default route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error.message);
    res.status(500).json({ 
        success: false,
        error: 'Internal server error'
    });
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});