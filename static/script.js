document.addEventListener('DOMContentLoaded', () => {
    const usernameInput = document.getElementById('usernameInput');
    const connectButton = document.getElementById('connectButton');
    const statusDiv = document.getElementById('status');
    const remoteUserInput = document.getElementById('remoteUserInput');
    const callButton = document.getElementById('callButton');
    const hangupButton = document.getElementById('hangupButton');
    const remoteAudio = document.getElementById('remoteAudio');
    const logDiv = document.getElementById('log');
    // const localAudio = document.getElementById('localAudio'); // Pour s'auto-écouter

    let ws = 'teste';
    let localStream = null;
    let peerConnection = null;
    let username = '';
    let remoteUsername = '';

    const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]; // Serveur STUN public

    function log(message) {
        const p = document.createElement('p');
        p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logDiv.prepend(p); // Ajouter en haut
        // Limiter le nombre de messages pour ne pas surcharger le DOM
        while (logDiv.children.length > 50) {
            logDiv.removeChild(logDiv.lastChild);
        }
    }

    // --- Fonctions de l'interface utilisateur ---
    function setCallControls(enabled) {
        remoteUserInput.disabled = !enabled;
        callButton.disabled = !enabled;
    }

    function setHangupControls(enabled) {
        hangupButton.disabled = !enabled;
    }

    // --- WebSockets ---
    connectButton.addEventListener('click', () => {
        
        username = usernameInput.value.trim();
        if (!username) {
            alert('Veuillez entrer un nom d\'utilisateur.');
            return;
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            log('Déjà connecté.');
            return;
        }

        statusDiv.textContent = 'Statut: Connexion...';
        log(`Tentative de connexion au serveur WebSocket en tant que ${username}...`);
        ws = new WebSocket(`ws://${window.location.hostname}:8000/ws/${username}`);
        console.log(ws)
        ws.onopen = async () => {
            statusDiv.textContent = 'Statut: Connecté';
            log('Connecté au serveur WebSocket.');
            connectButton.disabled = true;
            usernameInput.disabled = true;
            setCallControls(true); // Activer les contrôles d'appel

            // Obtenir le flux média local (micro)
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                // if (localAudio) localAudio.srcObject = localStream; // Pour s'auto-écouter
                log('Accès au microphone obtenu.');
            } catch (error) {
                log(`Erreur d'accès au microphone: ${error.name}`);
                alert(`Impossible d'accéder au microphone: ${error.message}`);
                ws.close();
            }
        };

        ws.onmessage = async (event) => {
            const message = JSON.parse(event.data);
            log(`Message reçu: ${message.type}`);

            switch (message.type) {
                case 'offer':
                    if (peerConnection) {
                        log('Erreur: Déjà en appel ou connexion existante.');
                        return;
                    }
                    remoteUsername = message.from;
                    log(`Appel entrant de ${remoteUsername}.`);
                    await handleOffer(message.sdp);
                    break;
                case 'answer':
                    await handleAnswer(message.sdp);
                    break;
                case 'candidate':
                    await handleCandidate(message.candidate);
                    break;
                case 'call_end':
                    log(`${message.from} a raccroché.`);
                    handleHangup();
                    break;
                case 'user_not_found':
                    log(`Erreur: L'utilisateur ${message.target_user} n'est pas connecté.`);
                    handleHangup(); // Raccrocher si l'utilisateur n'est pas trouvé
                    break;
                case 'error':
                    log(`Erreur du serveur: ${message.message}`);
                    break;
            }
        };

        ws.onclose = () => {
            statusDiv.textContent = 'Statut: Déconnecté';
            log('Déconnecté du serveur WebSocket.');
            connectButton.disabled = false;
            usernameInput.disabled = false;
            setCallControls(false);
            setHangupControls(false);
            handleHangup(); // Nettoyer la connexion WebRTC si WebSocket se ferme
        };

        ws.onerror = (error) => {
            log(`Erreur WebSocket: ${error}`);
            statusDiv.textContent = 'Statut: Erreur';
        };
    });

    // --- WebRTC ---
    async function createPeerConnection() {
        peerConnection = new RTCPeerConnection({ iceServers: STUN_SERVERS });
        log('RTCPeerConnection créé.');

        // Ajouter les pistes locales au PeerConnection
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });
        }

        // Échanger les candidats ICE
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                log('Envoi du candidat ICE...');
                ws.send(JSON.stringify({
                    type: 'candidate',
                    target_user: remoteUserInput.value || remoteUsername, // Cible l'utilisateur distant
                    candidate: event.candidate,
                    from: username
                }));
            }
        };

        // Recevoir les pistes du pair distant
        peerConnection.ontrack = (event) => {
            log('Piste distante reçue.');
            if (remoteAudio.srcObject !== event.streams[0]) {
                remoteAudio.srcObject = event.streams[0];
                log('Flux audio distant défini sur l\'élément audio.');
            }
        };

        // Gérer les changements d'état de la connexion ICE
        peerConnection.oniceconnectionstatechange = () => {
            log(`État de la connexion ICE: ${peerConnection.iceConnectionState}`);
            if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'closed') {
                log('Connexion ICE échouée ou déconnectée. Raccrochage...');
                handleHangup();
            }
        };
    }

    // Gérer l'appel sortant
    callButton.addEventListener('click', async () => {
        remoteUsername = remoteUserInput.value.trim();
        if (!remoteUsername) {
            alert('Veuillez entrer un nom d\'utilisateur distant.');
            return;
        }
        if (remoteUsername === username) {
            alert('Vous ne pouvez pas vous appeler vous-même.');
            return;
        }

        log(`Appel de ${remoteUsername}...`);
        callButton.disabled = true;
        setHangupControls(true); // Activer le bouton raccrocher

        await createPeerConnection();

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        log('Envoi de l\'offre au serveur de signalisation...');
        ws.send(JSON.stringify({
            type: 'offer',
            target_user: remoteUsername,
            sdp: peerConnection.localDescription,
            from: username
        }));
    });

    // Gérer une offre entrante (pour le destinataire)
    async function handleOffer(offer) {
        setCallControls(false); // Désactiver l'appel pendant la réception
        setHangupControls(true); // Activer raccrocher

        await createPeerConnection(); // Crée la connexion ici pour le receveur
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        log('Envoi de la réponse au serveur de signalisation...');
        ws.send(JSON.stringify({
            type: 'answer',
            target_user: remoteUsername, // Le destinataire est l'expéditeur de l'offre
            sdp: peerConnection.localDescription,
            from: username
        }));
    }

    // Gérer une réponse entrante (pour l'initiateur)
    async function handleAnswer(answer) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        log('Réponse distante définie.');
        setCallControls(false); // Désactiver les contrôles d'appel une fois l'appel établi
        setHangupControls(true);
    }

    // Gérer un candidat ICE entrant
    async function handleCandidate(candidate) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            log('Candidat ICE ajouté.');
        } catch (e) {
            console.error('Erreur lors de l\'ajout du candidat ICE:', e);
            log('Erreur lors de l\'ajout du candidat ICE.');
        }
    }

    // Raccrocher l'appel
    hangupButton.addEventListener('click', () => {
        log('Raccrochage...');
        ws.send(JSON.stringify({
            type: 'call_end',
            target_user: remoteUserInput.value || remoteUsername,
            from: username
        }));
        handleHangup();
    });

    function handleHangup() {
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop()); // Arrêter les pistes du micro
            localStream = null;
        }
        remoteAudio.srcObject = null;
        log('Appel terminé et connexion nettoyée.');
        setCallControls(true); // Réactiver le bouton d'appel
        setHangupControls(false); // Désactiver le bouton raccrocher
        remoteUserInput.value = ''; // Effacer le nom d'utilisateur distant
    }
});