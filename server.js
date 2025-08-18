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
    DisconnectReason
} = require('baileys');
const { createClient } = require('@supabase/supabase-js');
const { Mutex } = require('async-mutex');
const { put } = require('@vercel/blob');
const config = require('./config');
const path = require('path');

const app = express();
const port = config.PORT || 3000;
const msgRetryCounterCache = new NodeCache();
const mutex = new Mutex();
let session;

// Initialize Supabase client
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);

app.use(express.static(path.join(__dirname, 'public')));

// WhatsApp connection handler with memory-based session
async function connector(phoneNumber, res) {
    const sessionId = Date.now().toString(); // Unique ID for the session
    const virtualFiles = {}; // Stores session files in memory

    // Custom auth state implementation
    const authState = {
        state: {
            creds: null,
            keys: {}
        },
        saveCreds: () => {
            // Save credentials to virtual files
            virtualFiles['creds.json'] = JSON.stringify(authState.state.creds);
        },
        saveKeys: () => {
            // Save keys to virtual files
            for (const [id, key] of Object.entries(authState.state.keys)) {
                virtualFiles[`${id}.json`] = JSON.stringify(key);
            }
        }
    };

    // Initialize with empty state
    authState.state.creds = {
        someAccountStuff: 'initial'
    };

    session = makeWASocket({
        auth: {
            creds: authState.state.creds,
            keys: makeCacheableSignalKeyStore(authState.state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
        },
        logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
        browser: Browsers.macOS("Safari"),
        markOnlineOnConnect: true,
        msgRetryCounterCache,
        getMessage: async (key) => {
            return null;
        }
    });

    if (!session.authState.creds.registered) {
        await delay(1500);
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const code = await session.requestPairingCode(cleanNumber);
        
        if (!res.headersSent) {
            res.json({ 
                success: true,
                code: code?.match(/.{1,4}/g)?.join('-'),
                message: 'Use this code to pair your device'
            });
        }
    }

    session.ev.on('creds.update', authState.saveCreds);

    session.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log('WhatsApp connected successfully');
            await delay(5000);
            
            try {
                // Save all keys before uploading
                authState.saveKeys();
                authState.saveCreds();
                
                // Upload all virtual files
                for (const [fileName, fileContent] of Object.entries(virtualFiles)) {
                    // Upload to Vercel Blob
                    await put(`${sessionId}/${fileName}`, fileContent, {
                        access: 'public',
                        addRandomSuffix: false
                    });
                    
                    // Upload to Supabase
                    const { error } = await supabase.storage
                        .from('sessions')
                        .upload(`${sessionId}/${fileName}`, fileContent);
                    
                    if (error) throw error;
                }

                const fullSessionId = config.PREFIX + sessionId;
                await session.sendMessage(session.user.id, { 
                    text: `*Session ID*\n\n${fullSessionId}\n\n${config.MESSAGE}`
                });
                
                if (config.IMAGE) {
                    await session.sendMessage(session.user.id, { 
                        image: { url: config.IMAGE },
                        caption: `Session ID: ${fullSessionId}`
                    });
                }
            } catch (error) {
                console.error('Session handling error:', error);
            } finally {
                // Clear memory
                virtualFiles = {};
                if (session) session.end();
            }
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            handleDisconnect(reason);
        }
    });
}

function handleDisconnect(reason) {
    if ([DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.restartRequired].includes(reason)) {
        console.log('Connection lost, attempting to reconnect...');
        connector();
    } else {
        console.log(`Disconnected! Reason: ${reason}`);
        if (session) session.end();
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
        res.status(500).json({ 
            success: false,
            error: 'Failed to generate pairing code'
        });
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