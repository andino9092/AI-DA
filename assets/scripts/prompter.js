const { parentPort } = require('worker_threads');
const { config } = require('dotenv');
const path = require('path');

const { PvRecorder } = require('@picovoice/pvrecorder-node');
const { PicoLLM } = require('@picovoice/picollm-node');
const { Cobra } = require('@picovoice/cobra-node');
const { Cheetah } = require('@picovoice/cheetah-node');

config();
const modelPath = path.join(__dirname, './../models');
const llmPath = path.join(modelPath, 'llama3_8b_instruct.pllm');

class PromptController {
  accessKey = process.env.ACCESS_KEY;

  recorder;
  leopardModel;
  llm;

  constructor(recorderFrames = 512) {
    // Start recording convo
    this.recorder = new PvRecorder(recorderFrames);
    // this.llm = new PicoLLM(this.accessKey, llmPath);
    this.cheetahModel = new Cheetah(this.accessKey)
    this.cobraModel = new Cobra(this.accessKey);
  }

  async listenForWords(){
    this.recorder.start();
    let frames = [];
    let flag = false;
    let detectedVoice = false;
    while (true){
      const frame = await this.recorder.read();
      const [partialTranscript, isEndpoint] = this.cheetahModel.process(frame)
      if (isEndpoint){
        return this.cheetahModel.flush();
      }
    }


  }

  async promptName() {
    const header =
      `You are a desktop assistant who's name is Aida.
      `;
    // Output a prompt to user asking for script name
    console.log('What would you like to name the script?')

    const scriptName = await this.listenForWords();
    return scriptName.replace(' ', '_')
    // const prompt = 'The user will give you a name to a script. Return the response in this format: {scriptName}. Please infer to the best of your ability.'
    // this.llm.generate(prompt)
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


module.exports = {
  PromptController,
}
