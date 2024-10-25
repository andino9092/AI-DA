const { config } = require('dotenv');

const { PvRecorder } = require('@picovoice/pvrecorder-node');
const { Porcupine, BuiltinKeyword } = require('@picovoice/porcupine-node');
const path = require('path');
const { parentPort } = require('worker_threads');
const { Rhino } = require('@picovoice/rhino-node');
const { Picovoice } = require('@picovoice/picovoice-node');
const fs = require('fs');
const { Leopard } = require('@picovoice/leopard-node');
const { Cobra } = require('@picovoice/cobra-node');

config();

const modelPath = path.join(__dirname, './../models');
const wakeWordPath = path.join(modelPath, 'Hey-Aida_en_mac_v3_0_0.ppn');
const intentPath = path.join(modelPath, 'AIDA_en_mac_v3_0_0.rhn');
console.log('Wake word path: ', wakeWordPath);
console.log('Intent path: ', intentPath);

class IntentController {
  accessKey = process.env.ACCESS_KEY;

  picoModel;
  leopardModel;
  cobraModel;
  recorder;
  phraseProcessingStatus = false;
  voiceDetected = false;
  lastIntentResponse;
  audioBuffer = [];
  stop = false;
  constructor(recorderFrames = 512) {
    const keywordCallback = async (index) => {
      console.log('Yes?');
      this.phraseProcessingStatus = true;
      this.voiceDetected = true;
    };

    const intentCallback = async (inference) => {
      this.lastIntentResponse = inference;
      this.phraseProcessingStatus = false;
    };
    try {
      console.log('opening model');
      this.leopardModel = new Leopard(this.accessKey);
      this.cobraModel = new Cobra(this.accessKey);
      this.picoModel = new Picovoice(
        this.accessKey,
        wakeWordPath,
        keywordCallback,
        intentPath,
        intentCallback,
      );
    } catch (error) {
      console.log(error);
      throw new Error('error:' + error);
    }
    this.recorder = new PvRecorder(recorderFrames);
  }


  startRecording = async () => {
    this.recorder.start();
    this.stop = false;
    console.log("I'm listening...");
    while (this.recorder.isRecording) {
      if (this.stop){
        continue;
      }
      try {
        const frame = await this.recorder.read();
        // If wake word activated or voice detected from cobra
        this.picoModel.process(frame);
        const stillTalking = this.voiceDetected
          ? this.cobraModel.process(frame)
          : 0;
        if (this.phraseProcessingStatus || this.voiceDetected) {
          this.audioBuffer.push(...frame);
        }

        // If a voice was detected earlier and intent matching is finished but cobra currently detects no voice, then set to voiceDetected to false
        if (this.voiceDetected && !this.phraseProcessingStatus) {
          if (stillTalking < 0.1) {
            console.log('Voice no longer detected...');
            this.voiceDetected = false;
            // If the last response said that it was not understood, then search it up
            if (!this.lastIntentResponse?.isUnderstood) {
              const audioBufferInt16 = new Int16Array(this.audioBuffer);
              try {
                const { transcript, words } =
                  this.leopardModel.process(audioBufferInt16);
                console.log(transcript);
              } catch (error) {
                console.log(error);
              }
              this.audioBuffer = [];
            }
            // If it was understood, send it back to the parentPort
            else {
              parentPort.postMessage({
                response: 'intent',
                content: this.lastIntentResponse,
              });
            }
            this.lastIntentResponse = undefined;
          }
        }
      } catch (err) {
        console.log(err);
        break;
      }
    }
  };

  stopRecording = async () => {
    console.log('stopping recording')
    this.stop = true;
    // await this.recorder.stop();
    // await this.picoModel.release();
    // await this.leopardModel.release();
  };

  processCommand = async () => {};
}

const recorderController = new IntentController();

parentPort.on('message', (msg) => {
  console.log(msg)
  if (msg.action == 'start') {
    console.log('starting listening...');
    recorderController.startRecording();
  }
  if (msg.action == 'pause') {
    recorderController.stopRecording();
  }
  if (msg.action == 'close') {
    recorderController.stopRecording();
    parentPort.postMessage({ response: 'closed' });
  }
});
