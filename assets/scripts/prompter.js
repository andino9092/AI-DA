const { parentPort } = require('worker_threads');
const { config } = require('dotenv');
const path = require('path');

const { PvRecorder } = require('@picovoice/pvrecorder-node');
const { PicoLLM } = require('@picovoice/picollm-node');

config();
const modelPath = path.join(__dirname, './../models');
const llmPath = path.join(modelPath, 'llama3_8b_instruct.pllm');

class PromptController {
  accessKey = process.env.ACCESS_KEY;

  recorder;
  llm;

  constructor(recorderFrames = 512) {
    // Start recording convo
    this.recorder = new PvRecorder(recorderFrames);
    this.llm = new PicoLLM(this.accessKey, llmPath);
  }

  async promptName() {
    const header =
      `You are a desktop assistant who's name is Aida.
      `;

    const prompt = 'The user will give you a name to a script. Return the response in this format: {scriptName}. Please infer to the best of your ability.'
    
  }
}

const promptCtrl = new PromptController();

parentPort?.on('message', async (msg) => {
  switch (msg.action) {
    case 'promptName':
      const scriptName = await promptCtrl.promptName();
      parentPort.postMessage({
        action: 'startRecording',
        scriptName: scriptName,
      });
      break;

    default:
      throw new Error('message received is unrecognized');
      break;
  }
});
