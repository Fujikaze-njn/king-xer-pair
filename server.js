const express = require('express');
const fs = require('fs');
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
const config = require('./config');
const path = require('path');
const crypto = require('crypto');
const app = express();
const port = config.PORT || 7860;
const msgRetryCounterCache = new NodeCache();
const mutex = new Mutex();
let session;

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);

app.use(express.static(path.join(__dirname, 'public')));

async function uploadSession(sessionDir) {
    try {
        const files = fs.readdirSync(sessionDir);
        const sessionId = crypto.randomBytes(8).toString('hex');
        for (const file of files) {
            const filePath = path.join(sessionDir, file);
            const fileContent = fs.readFileSync(filePath);
            
            const { error } = await supabase.storage
                .from('session')
                .upload(`${sessionId}/${file}`, fileContent);
            
            if (error) throw error;
        }
        
        return sessionId;
    } catch (error) {
        console.error('Supabase upload error:', error);
        throw error;
    }
}

// WhatsApp connection handler
async function connector(phoneNumber, res) {
    const sessionDir = './temp_session';
    
    try {
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir);
        }
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        session = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
            },
            logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
            browser: Browsers.macOS("Safari"),
            version,
            markOnlineOnConnect: true,
            msgRetryCounterCache
        });

        session.ev.on('creds.update', saveCreds);

        if (!session.authState.creds.registered) {
            await delay(1500);
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
            try {
                const code = await session.requestPairingCode(cleanNumber);
                if (!res.headersSent) {
                    res.send({ code: code?.match(/.{1,4}/g)?.join('-') });
                }
            } catch (error) {
                console.error('Pairing code request error:', error);
                if (!res.headersSent) {
                    res.status(500).json({ 
                        success: false,
                        error: 'Failed to generate pairing code'
                    });
                }
                return;
            }
        }

        session.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                console.log('Connected successfully');
                await delay(5000);
                
                try {
                    // Upload all session files
                    const sessionId = await uploadSession(sessionDir);
                    const sID = config.PREFIX + sessionId;
                    
                    // Send the image with session ID directly
                    await session.sendMessage(session.user.id, { 
                        image: { url: `${config.IMAGE}` }, 
                        caption: `*Session ID*\n\n${sID}\n\nDo not share this with anyone!` 
                    });
                
                } catch (error) {
                    console.error('Error:', error);
                } finally {
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                }
            } else if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    console.log('Logged out, please restart the server');
                    if (session) {
                        session.end();
                    }
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                } else {
                    console.log('Connection lost, reconnecting...');
                    setTimeout(() => connector(phoneNumber, res), 5000);
                }
            }
        });
    } catch (error) {
        console.error('Connector error:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false,
                error: 'Connection failed',
                details: error.message
            });
        }
        // Clean up session directory on error
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
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
        await connector(phoneNumber, res);
    } catch (error) {
        console.error('Pairing error:', error);
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

// Default route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});