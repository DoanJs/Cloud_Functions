export interface Child {
  id: string;
  teacherIds: string[];
}

export interface Plan {
  id: string;
  childId: string;
  teacherIds: string[];
  status: string
}
export interface Report {
  id: string;
  childId: string;
  teacherIds: string[];
  status: string
}

// https://api.telegram.org/bot   /getUpdates
// - https://api.telegram.org/bot8824321052:AAHcALH25Jlyr5wJH_7d6CXEoIFel_PdzhE/getWebhookInfo
// - https://api.telegram.org/bot   /deleteWebhook
// - https://api.telegram.org/bot8824321052:AAHcALH25Jlyr5wJH_7d6CXEoIFel_PdzhE/setWebhook?url=https://telegramwebhook-wka74oo7xa-as.a.run.app
// https://api.telegram.org/bot8824321052:AAHcALH25Jlyr5wJH_7d6CXEoIFel_PdzhE/sendMessage?chat_id=8338357435&text=abc 123

// 8824321052:AAHcALH25Jlyr5wJH_7d6CXEoIFel_PdzhE
// lfjyUePKV5hLwwFCMxWZzn87BF53
