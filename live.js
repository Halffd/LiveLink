//var ytChLiveStream = require('youtube-channel-live-stream')
//ytChLiveStream.getLiveStream('UCNlfGuzOAKM1sycPuM_QTHg',false)
//.then((res)=>console.log(res));
import { exec } from 'child_process';
import { promisify } from 'util';
  import promptSync from 'prompt-sync';
import { HolodexApiClient } from 'holodex.js';
import { spawn } from 'child_process';
import * as fs from 'fs';


// Read the JSON file
const jsonData = fs.readFileSync('../build/key.json', 'utf-8');

// Parse the JSON data
const data = JSON.parse(jsonData);
const key = data.key;
// Access the data
console.log(key); // Output: "John Doe"
const client = new HolodexApiClient({
  apiKey: key, // Provide your personal API KEY. You can acquire a API KEY via the Account Settings page.
});
const dir = "../build/"
// Constants for directory and filenames
const titlesFile = `${dir}titles.txt`;
const ytFile = `${dir}yt.txt`;
var filters = ["HanasakiMiyabi","KanadeIzuru","Arurandeisu","Rikka","AstelLeda","KishidoTemma","YukokuRoberu","KageyamaShien","AragamiOga","YatogamiFuma","UtsugiUyu","MinaseRio","RegisAltare","AxelSyrios","TempusVanguard","GavisBettel","MachinaXFlayon","BanzoinHakka","JosuijiShinri","HolostarsEnglish-Armis-","JurardTRexford","Goldbullet","Octavio","CrimzonRuze", 'Ruze', 'Gavis', 'Octavio', 'Jurard', 'Regis', 'Machina', 'Bandage', 'VantacrowBringer', 'Yu Q', 'Wilson', `A-Kun`, 'AdmiralBahroo', 'AfressHighwind', 'AiharaYachiyo', 'AimuSora', 'Aionnovach', 'AionNova', 'Ironinu', 'AironuInu', 'AkabaneZack', 'AkagiWen', 'AkanariMatoi', 'AkaneJun', 'AkemiNekomachi', 'AkewaruDireza', 'Akichannel', 'AkioTitoAksIsogai', 'AkiraDolce', 'AkiraFujimaru', 'Akkun', 'AkkunFrånLandetUndervinden', 'AkosiDogie', 'AkumagawaMitan', 'AkumagawaMitan', 'AkunoShiro', 'AlbanKnox', 'AldenRyouken', 'AldoSpacewool', 'AleisterNoire', 'Alka', 'AlphaAniki', 'Draft:AmakakeYui', 'AmanogawaKousei', 'AmashitaKite', 'AmekaYasumu', 'AndiAdinata', 'AnpuGyaru', 'AnpuGyaru(LordoftheDead)', 'AntoneoDL', 'Antoneo', 'AoiCrescent', 'AozoraAlphieMashimaro', 'ApolloKepler', 'AragamiOga', 'Areku', 'Arurandeisu', 'AruseInu', 'AsahiMaki', 'AsahiMaki', 'AstelLeda', 'AsterArcadia', 'Avalan467', 'AvalanIronClad', 'AxelSyrios', 'AxiaKrone', 'Aza', 'Azashi', 'Draft:AzeruOfficial', 'Baacharu', 'BACONGUDEN', 'Bakenran', 'BakenVT', 'BankiYakou', 'BanzoinHakka', 'Bashuro', 'BeckoningKittyTatamaru', 'BeckyVT', 'BelmondBanderas', 'BenjaminDatum', 'BigGil', 'Bigredthesecond', 'Bigred', 'BitouKaiji', 'Blithe', 'Blu', 'BlueBirdHay', 'BobbyMoonlight', 'BonnivierPranaja', 'BOOMBA', 'Breadmilkbread', 'DylanCantwell', 'Bubi', 'BungoTaiga', 'CaalunAkiyama', 'CaptainTesk', 'Carillus', 'CatatoCorner', 'Cece', 'Celasots', 'Celastos', 'ChairGTables', 'ChakraEisen', 'Chaos', 'Chaosofseth', 'ChaosofSeth', 'CharlesCaitou', 'CheriBuro-chan', 'Chia-P', 'Chok', 'ChrisFalconSTB', 'ChrisFalconSTB', 'ChronicleVTuber', 'ChronicleSegregate', 'Cielwave', 'CircusPircus', 'Co-Dee', 'CodeSOLCas', 'ComboPanda', 'ComfyCatboy', 'Cookiecatlove69', 'Hemlockked', 'Cookiiee775', 'AndreiAlastair', 'CoreyRaknok', 'CoreyRaknok', 'Cresoneko', 'Creso', 'CrimsonMoonster', 'RenYakokami', 'Daem', 'DaidouShinove', 'Daidus', 'DaimonjiRyugon', 'DanAzmi', 'DangerDolan', 'DantePeak', 'Deat', 'Deathawakener', 'Deathawakener', 'DeepBlizzardMiyuki', 'DelaandHadou', 'DoppioDropscythe', 'DoruGorunn', 'DraculaMorphy', 'Drowsyrowan', 'DrowsyRowan', 'EdgardoNiwatori', 'EgguTamago', 'Eggy', 'EibiKusanagi', 'Eiikochiida', 'AmemoriSouma', 'Eisu', 'EJS1412', 'VirtualizeDave', 'ElionBlitz', 'ElisifirAsura', 'EngineerGamingLive', 'EnjiNotokunchoro', 'EnricoZenitani', 'EnvyAmou', 'Era', 'EsseFrolic', 'EwanHUNT0', 'EwanHUNT', 'ExAlbio', 'FairBalanceEven', 'FalseEyeD', 'FedrizMarini', 'FeiPradipta', 'FiskyPfötchen', 'Draft:Fiwi', 'FlaretheFireflower', 'PenguinAce', 'Flybel', 'FoxyJoel', 'FrankTheTank1997', 'Binjo-kun', 'FukuyaMaster', 'FulgurOvid', 'FuraKanato', 'Furtrap', 'FushimiGaku', 'FuwaMinato', 'GameClubProject', 'Gaon', 'GatchmanV', 'GavisBettel', 'Draft:Genchosu', 'GenzukiTojiro', 'Gerdew', 'GilzarenIII', 'GitanesValheim', 'Glados5555', 'NettleAurelia', 'Glados5555', 'RikuHikaru', 'Glitch', 'GlitchedRune', 'GlitchedRune', 'Gnom2D', 'Goonyella', 'Gorilla', 'GreatMoonAroma', 'GrifNMore', 'GustheGummyGator', 'GweluOsGar', 'GyotaAkamazu', 'HaYun', 'HachigatsuNiyuki', 'Hakuja', 'HanChiho', 'HanabatakeChaika', 'HanabusaIbuki', 'HanasakiMiyabi', 'HanayuraKanon', 'Hanbyeol', 'HanoHirai', 'HarusakiAir', 'HarutaDanantya', 'Hasu', 'HasukeCh', 'Hasuke', 'HayabusaSanomoe', 'Draft:Heart', 'Heather1320', 'Blankieblannk', 'Hellbent', 'Hellness', 'HexHaywire', 'HibachiMana', 'HizakiGamma', 'HogwashHerbert', 'Dragoniclife', 'HokkiYoki', 'HoshiYumekawa', 'HoshirubeSho', 'Hunger', 'Hunter', 'Ibrahim', 'Icotsu', 'IdrisPasta', 'IgniRedmond', 'Ihga10ip', 'Kryptic', 'Ihga10ip', 'SpiritBox', 'IkeEveland', 'IlieTou', 'InamiRai', 'InochizunaRuka', 'InTheLittleWood', 'InuiShinichiro', 'InuyamaTamaki', 'IriasYoruha', 'IshigamiShachi', 'IsseiKai', 'ItoLife', 'ItoneLloyd', 'JackTW', 'Jacob(Hikari)Murphy', 'JanuRanata', 'JaretFajrianto', 'Jiinh', 'JoeRikiichi', 'JoeyBagels', 'Draft:JossehtNeko', 'JosuijiShinri', 'JPsCorvetteC7', 'KazuhiroShoji', 'JunStraya', 'Junichi', 'JuwunSugarbloom', 'KWA', 'KaduNya', 'KagamiHayato', 'KagamiKira', 'KageyamaShien', 'KagutsuHomura', 'KaiSuperbia', 'KaiaSol', 'KaidaHaru', 'Kakage', 'Kamito', 'KamiyaJuu', 'Kamuchen', 'Kamuchen', 'KanadeIzuru', 'Kanae', 'KandaShoichi', 'Kangaroobloo', 'BlooKangaroo', 'KapnKaveman', 'CaptainKaveman', 'Karo', 'KatsuKarechi', 'KarechiKatsu', 'KawamuraAgil', 'KayakuguriKario', 'KeichiieVtuber', 'KeichiieTakahashi', 'KeigoAria', 'Keitaa', 'Keke', 'KenmochiToya', 'Kentacalamity', 'KevinVangardo', 'Khaojao', 'Khyo', 'KikoroIsi', 'Kirschtorte', 'KishidoTemma', 'KishinShinobi', 'Kistago', 'Kistago', 'KitashiroYuki', 'KitsukamiNiji', 'KittenBlaze', 'Draft:KoganeRitsu', 'KogumaKeiya', 'KokoroIchiru', 'Konzetsu', 'KotaKotonya', 'Kouichi', 'KoyanagiRou', 'KugaLeo', 'KujouTaiga', 'KumagayaTakuma', 'Kurohiko', 'KurokamiAmagiri', 'KurokamiAmagiri', 'KurosakiKuzune', 'Kuroshka', 'Kuzuha', 'Kwite', 'KyoKaneko', 'Kyonmyu', 'KyoshiAkazora', 'Kyoslilmonster', 'Kyouka', 'Kyublitz', 'LagannFitzgerald', 'LaurenIroas', 'Lawiz', 'Leo', 'LeoDickinson', 'LeosVincent', 'LewisQuadruped', 'Lolathon', 'LordAethelstan', 'LordCommanderChaos', 'Lorou', 'Lortlimbah', 'Lorulewaifu', 'FreeDimension', 'LouisSilvestre', 'LucaKaneshiro', 'LucidAstracelestia', 'LupoMarcio', 'Luxe', 'Lyønix', 'MachinaXFlayon', 'MaeandShika', 'MagniDezmond', 'MaimotoKeisuke', 'MakiMafuyu', 'MakKoeda', 'Maqinor101', 'Akame', 'MaScottBun', 'MashiroMeme', 'Matzzteg', 'Matzzteg', 'MayuzumiKai', 'MemradHalftone', 'Mentlesaur', 'Mentlesaur', 'Merryweather', 'MikageYamato', 'Miki', 'MinSuha', 'MinamotoGenki', 'Minase', 'MinaseRio', 'MinatoAkiyama', 'Miumiu', 'MiuraTokage', 'MiuraTokage', 'MiyabiKirito', 'MiyabiKirito', 'MiyazakiYuzuya', 'Mociren', 'Moenaomii', 'Mominintime', 'MinoMinokawa', 'MomoiroKohi', 'MonsterZMATE', 'MoraisHD', 'Draft:MoscowMule', 'MrMask', 'MrVortex', 'MurakumoKagetsu', 'MurasakiHiroshi', 'MystaRias', 'NagaoKei', 'NaiNohni', 'Naikaze', 'NakanoJoelene', 'HaruChigainu', 'NakanoJoelene', 'TheR-Man', 'Nama', 'NamineSae', 'NanahaRui', 'NanaseTaku', 'NanoSNAkeR', 'Nanosnaker', 'Narcat', 'Narcat', 'NaritaMediciana', 'NaritaMD', 'NarukamiSabaki', 'NaruseNaru', 'NaYuta', 'Draft:NemurenaiKai', 'NemutakaYuta', 'NicJellie', 'NightmareDetective', 'Niikemi', 'NimbusIncubus', 'NinomiyaSho', 'NoirVesper', 'NordikOwl', 'NoviceZoel', 'Nullium', 'NuxTaku', 'Dane.ina', 'NyankoEmon', 'NyakunoSensei', 'NyakunoSensei', 'NyanNyanMiruku', 'Nyapuru', 'OliverEvans', 'OokamiShiro', 'Draft:OokuraYusuke', 'OrkPodcaster', 'ŌsakaMomo', 'OshiroIto', 'Otenonth', 'Pagemi', 'Draft:Pakael', 'Paryi', 'Peanuts-kun', 'Peck', 'PekoVirus', 'NickStarling', 'Pending', 'Penumbral', 'Pharaohcrab', 'RaputaShoboshi', 'Phi', 'Polygondonut', 'Premia007', 'AidanClayAmodeo', 'Prof.Harunozuka', 'ProjectUglyBastard', 'RabbitSenseiVT', 'RadnaAvaritia', 'Raelice', 'Raftak', 'RaiGalilei', 'RaskaMalendra', 'RavenCassidy', 'RaviNarendra', 'RayneFujita', 'RegisAltare', 'ReiZyphris', 'ReiZyphris', 'ReiZyphris', 'RenZotto', 'RenjiroJunichi', 'ReyaVR', 'ReynardBlanc', 'RezaAvanluna', 'Rigel.CH', 'RiiKami', 'Rikka', 'RiksaDhirendra', 'Rimmu', 'RisottoGambino', 'Robo-ComboPanda', 'RoenTheWorld', 'Roi', 'Roxhas', 'Roxhas', 'RPR', 'Rubius', 'RunWyld', 'RyodaAkamazu', 'RyozenReed', 'RyuukiTatsuya', 'SaegusaAkina', 'Sahana', 'SaiRoose', 'SaikiIttetsu', 'Saizono', 'KiraKirameki', 'Saka', 'Salamander', 'Samael', 'Sarumonin', 'SatoBenimaru', 'SayoshigureKou', 'SazanamiToa', 'SebastianAizawa', 'Seiya', 'SenaRedo', 'SeoCheonHae', 'SeraphDazzlegarden', 'SetoKazuya', 'ShellinBurgundy', 'ShibuyaHajime', 'ShibuyaHAL', 'Shiharu', 'ShikiTaigen', 'ShikinagiAkira', 'Shimonz', 'ShinKiru', 'ShindoRaito', 'ShinitriIkoya', 'ShinitriIcekoya', 'Shinma', 'Draft:ShinonomeArata', 'ShiraitoSyrlight', 'ShirayukiReid', 'ShiroganeArugin', 'ShiroganeArugin', 'Shiroken', 'ShiroseYuuri', 'Shirybun', 'ShizukaDia', 'ShosanRose', 'ShoutaRen', 'ShuYamino', 'Shxtou', 'Siliciagaming', 'ShikiShiro', 'Draft:Silvic', 'Sirius', 'Skiyoshi', 'Bunny', 'Sleeper', 'Smol&Stronk', 'Sodapoppin', 'Solly', 'SomaRigel', 'SonnyBrisko', 'Sora-Chan', 'Draft:Spite', 'SpoiledMouse', 'Starstorm', 'StellaValentine303', 'TokkiVelveteen', 'Stiggerloid', 'Draft:SugarRushTTV', 'SumioSantana', 'SunKenji', 'Susam', 'SuzukiMasaru', 'SuzuyaAki', 'SweetCheeks', 'Sweetotoons', 'T1-PP', 'Tabibito', 'TadaAce', 'TaikunZ', 'TailBlade', 'TaiyoRise', 'TakaRadjiman', 'Takahata', 'TakamoriTsuzuru', 'TakaoShinji', 'TakehanaNote', 'Tako', 'Tanoshiba', 'TatsugamiZuii', 'Tayn', 'Teanos', 'Tekitou', 'TenkaiTsukasa', 'TetsuChin', 'Racoro', 'TetsuyaKazune', 'TheEndoftheRedDawn', 'Noxen', 'TheHenzo', 'Theonemanny', 'Thesnakerox', 'Tichat002', 'VicChandler', 'TivoAlexia', 'Toaster', 'Tocci', 'TodokiUka', 'TokiTomoyasu', 'ToruKuma', 'Tostify', 'TsubakiSeigi', 'TsukishitaKaoru', 'TsukiyoSora', 'TsurugiNen', 'Scalesinger', 'TuskiBrown', 'Uka', 'UkiVioleta', 'UmakoshiKentarou', 'UmiyashanoKami', 'UraseSuu', 'Uriyone', 'UrokomiSui', 'UrsaScorpio', 'UrsaScorpio', 'GhostRothwel', 'UsamiRito', 'UtaiMakea', 'UtsugiUyu', 'UzukiKou', 'UzukiTomoya', 'V1nBoi', 'Draft:ValkyareYuno', 'Vee', 'VerVermillion', 'VianTuber', 'Vihaan', 'ViiRii', 'VinAlstair', 'VirionKisei', 'VoxAkuma', 'VtuberFan69', 'LeverBoi', 'Draft:VTuberKei', 'Vxsenna', 'WaluigiTime222', 'GrigoriiKuzmenko', 'Wanjan', 'WataraiHibari', 'WitsKho', 'Wood-d', 'XenoHorizon', 'XiuHua', 'XuniDD', 'Yagi', 'Yagiko', 'YakushijiSuzaku', 'YamiSensei', 'YamiSerafino', 'YamikumoKerin', 'YamisoraAlan', 'YashiroKizuku', 'YasyfiKun', 'YatakiKatisu', 'YatogamiFuma', 'YDDONC', 'YoakeLaiga', 'Yog', 'YokuRin', 'Yomiya', 'YorozuyaNico', 'YugaAltair', 'YugoAsuma', 'YuigaKohaku', 'YujiRavindra', 'YukkeShou', 'YukokuRoberu', 'YumekoRemi', 'YumeoiKakeru', 'ZenGunawan', 'Draft:ZeroViewz', 'Zhazha', 'Zonerrecryptonikharos', 'Draft:ZR', 'ZweiKanie']
// Get Usada Pekora's channel info
/*client.getChannel('UC1DCedRgGHBdm81E1llLhOQ').then(function (channel) {
  // handle result
  console.log(channel.name); // Pekora Ch. 兎田ぺこら
  console.log(channel.englishName); // Usada Pekora
  console.log(channel.subscriberCount); // 1540000
  client.getLiveVideos({ org: 'Hololive', sort: 'live_viewers', limit: lm }).then(function (videos) {
    // handle result
    console.log(videos);
    });
    client.getLiveVideos({ org: 'Hololive', sort: 'live_viewers', limit: lm }).then(function (videos) {
      // handle result
      console.log(videos);
      });
      });*/
      
      
      
      const prompt = promptSync();
      const execa = promisify(exec);
      var titles = []

// Get Hololive's stream

/*async function getHome(urlink) {
  try {
    //'https://www.youtube.com/results?search_query=hololive%7Cnijisanji%7C%E3%83%9B%E3%83%AD%E3%83%A9%E3%82%A4%E3%83%96%7C%E3%81%AB%E3%81%98%E3%81%95%E3%82%93%E3%81%98%7Cthunderia%7Cphaseconnect%7Cvshojo%7Cvspo+-male+-%E4%BB%A3%E8%A1%A8+-%E7%94%B7+-%E7%B5%8C%E9%A8%93%E8%80%85&sp=CAMSAkAB
    const urls = urlink
    let query = ''
    for (let l in urls) {
      query += urls[l]
      if (l != (urls.length - 1)) {
        query += '|' // '|'
      }
    }
    const response = await fetch(encodeURI(`https://www.youtube.com/results?search_query=${query}&sp=CAMSAkAB`))
    console.log(`https://www.youtube.com/results?search_query=${query}&sp=CAMSAkAB`)
    //  console.log(response)
    const text = await response.text()
    const html = await parse(text)
    const channels = []
    //console.log(html.childNodes[0])
    //var parser = new DOMParser();
    
    // Parse the text
    //var doc = parser.parseFromString(html, "text/html");

    // You can now even select part of that html as you would in the regular DOM 
    // Example:
    // var docArticle = doc.querySelector('article').innerHTML;
    const doc = new JSDOM(html)
    let content = null
    //console.log(doc.window.document.body.innerHTML);
    const script = doc.window.document.querySelectorAll('script')
    let links = []
    for (let i in script) {
      try { //console.log(i + ':-- ' + script[i])
        //console.log(script[i].innerHTML.indexOf('ytInitialData'))
        if (script[i].innerHTML.indexOf('var ytInitialData') >= 0 && script[i].innerHTML.indexOf('var ytInitialData') < 50) {
          content = script[i].innerHTML
        }
      } catch {
        console.log(-10)
      }
    }
    *.
    /*writeFile("./nijijs.js", content, function(err) {
        if(err) {
            return console.log(err);
        }
        console.log("The file was saved!");
    });         */
/*//var ytInitialData = null
var c
eval(content.replace('var ytInitialData', 'c'))
console.log(c.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents.length)
let iii = 0
for (let i in c.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents) {
  let cn = 'c'
  let m = true
  let mi=-1
  let title = 'n'
  try {
    if(iii > 5){
      //process.exit()
    }
    console.dir(c.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents[i].videoRenderer.title)
    title = c.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents[i].videoRenderer.title.accessibility.accessibilityData.label
    cn = c.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents[i].videoRenderer.longBylineText.runs[0].navigationEndpoint.commandMetadata.webCommandMetadata.url
    iii += 1
  }  catch(poi) {
    console.log(poi)
  }
  for(let j in filter){
    if(filter[j].toLowerCase().indexOf(cn.substring(2).toLowerCase()) != -1 || cn.substring(2).toLowerCase().indexOf(filter[j].toLowerCase()) != -1
        || title.toLowerCase().indexOf(filter[j].toLowerCase()) != -1
    ){
      m = false
      mi = filter[j]
    }
  }
  console.log(cn.substring(2) + ' . ' + m + ` ` + mi + ' ' + title)
  if (m) {
    links.push(cn.substring(1))
    titles.push(title)
  }
}
//process.exit()
return links
} catch (e) {
console.log(e)
return false
}
}
async function live(channelID) {
console.log(`https://youtube.com/${channelID}/live`)
try {
const response = await fetch(`https://youtube.com/@${channelID}/live`)
//  console.log(response)
const text = await response.text()
const html = await parse(text)
//console.log(html.childNodes[0])
//var parser = new DOMParser();

// Parse the text
//var doc = parser.parseFromString(html, "text/html");

// You can now even select part of that html as you would in the regular DOM 
// Example:
// var docArticle = doc.querySelector('article').innerHTML;
*/
/*const doc = new JSDOM(html)
console.log(doc.window.document.body.innerHTML);
writeFile("./dom.html", doc.window.document.body.innerHTML, function(err) {
  if(err) {
    return console.log(err);
   }
   console.log("The file was saved!");
 });         */
/*const canonicalURLTag = html.querySelector('link[rel=canonical]')
//const a = '\u0040'
const t = '' + html.querySelector(`meta[itemprop='name']`).getAttribute('content')
const canonicalURL = canonicalURLTag.getAttribute('href')
const isStreaming = canonicalURL.includes('/watch?v=')
return t
} catch (e) {
console.log({ e })
return false
}
}
*/
var vs
var vt = 0
async function dex(h = true, a = false, lm = 50) {
  let v
  let fav = `UC54JqsuIbMw_d1Ieb4hjKoQ,UCIfAvpeIWGHb0duCkMkmm2Q,UC6T7TJZbW6nO-qsc5coo8Pg,UC5CwaMl1eIgY8h02uZw7u8AUC9ruVYPv7yJmV0Rh0NKA,UC7YXqPO3eUnxbJ6rN0z2z1Q,UCJ46YTYBQVXsfsp8-HryoUA,UComInW10MkHJs-_vi4rHQCQ,UC4WvIIAo89_AzGUh1AZ6Dkg,UCcHHkJ98eSfa5aj0mdTwwLQ,UCt30jJgChL8qeT9VPadidSw,UC3K7pmiHsNSx1y0tdx2bbCw`
  let f = []
  let m = []
  if (a) {
    let all = await client.getLiveVideos({ sort: 'live_viewers', order: 'desc', status: 'live', limit: lm })
    return all;
  }
  for (let i of fav.split(',')) {
    let iv = await client.getLiveVideos({ channel_id: i, sort: 'live_viewers', order: 'desc', status: 'live', mentioned_channel_id: '', limit: lm })
    if (iv.length > 0) {
      f.push(iv[0])
    }
  }
  if (h) {
    v = await client.getLiveVideos({ org: 'Nijisanji', sort: 'live_viewers', order: 'desc', status: 'live', mentioned_channel_id: '', limit: lm })
    m = await client.getLiveVideos({ org: 'Hololive', sort: 'live_viewers', order: 'desc', status: 'live', mentioned_channel_id: '', limit: lm })
  } else {
    // r
  }
  let i = await client.getLiveVideos({ org: 'Independents', sort: 'live_viewers', order: 'desc', status: 'live', mentioned_channel_id: '', limit: 8 })
  let o = await client.getLiveVideos({ sort: 'live_viewers', order: 'desc', status: 'live', limit: 8 })
  console.log(f, v);
  vs = [f, v, m, i, o]
  console.log('vt', vt)
  if (vt == 0) {
    v = [...f, ...v, ...m, ...i, ...o]
  } else if (vt == 1) {
    //v = [...f, ...m, ...v, ...i, ...o]
    v = [...m, ...f, ...v, ...i, ...o]
  } else if (v == 2) {
    v = [...f, ...i, ...v, ...m, ...o]
  } else if (v == 3) {
    v = [...f, ...o, ...m, ...i, ...v]
  } else if (v == 4) {
    v = [...f, ...m, ...i, ...v, ...o]
  } else {
    v = [...f, ...i, ...m, ...v, ...o]
  }
  return v
}
function extractYouTubeUrls(videos) {
  const youtubeBaseUrl = 'https://www.youtube.com/watch?v=';
  const youtubeUrls = [];

  for (const video of videos) {
    const videoId = video.raw.id;
    const youtubeUrl = youtubeBaseUrl + videoId;
    youtubeUrls.push(youtubeUrl);
  }

  return youtubeUrls;
}
function os_func() {
  this.execCommand = function (cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout)
      });
    })
  }
}
function getVideoTitles(videos) {
  const titles = [];
  for (const video of videos) {
    console.log(video)
    const title = video.raw.title;
    titles.push(title);
  }
  
  return titles;
}


// Function to write data to a file
async function writeToFile(filename, data) {
  return new Promise((resolve, reject) => {
    fs.writeFile(filename, data.join('\n'), (err) => {
      if (err) {
        console.error('Failed to write file:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// Function to spawn a child process and wait for it to complete
async function spawnProcess(command, args) {
  return new Promise((resolve, reject) => {
    console.log(command, args);
    const childProcess = spawn(command, args);
    let output = '';
    let errorOutput = '';

    // Collect standard output
    childProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    // Collect standard error
    childProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    // Handle process termination
    childProcess.on('close', (code) => {
      if (code === 0) {
      	console.log(code);
        resolve(output);  // Resolve with output if successful
      } else {
        console.warn(output);
      
        reject(new Error(`Process exited with code: ${code}\n${errorOutput}`));  // Reject with error output
      }
    });
  });
}
// Main function
async function get() {
  let [a, b, method, limit, organization, screen, quality, channel] = process.argv;
  let videos = null;
  // const filters = []; // Define your filters here
  vt = organization !== undefined && organization >= 0 ? organization : 0;
  quality = quality === undefined ? 'best' : quality;
  limit = parseInt(limit);
  console.log(organization, vt, screen)
  if (channel !== undefined) {
    videos = [channel];
  } else {
    videos = await dex(true, vt >= 10, limit); // Adjust according to your logic
  }
  
  videos = videos.filter(video => {
    const channelName = video?.channel?.raw?.english_name?.toLowerCase().replace(/\s/g, '');
    const channelNameAlt = video?.channel?.raw?.name?.toLowerCase().replace(/\s/g, '');
    console.log(channelName, channelNameAlt);
    return !filters.some(filter => channelName?.includes(filter.toLowerCase()) || channelNameAlt?.includes(filter.toLowerCase()));
  });

  const titles = getVideoTitles(videos);
  videos = extractYouTubeUrls(videos);
  console.log(videos, titles, videos.join('\n'));

  try {
    await writeToFile(titlesFile, titles);
    await writeToFile(ytFile, videos);

    if (method >= 1) {
      if (method == 2) {
        spawnProcess(`${dir}live.exe`, [vt, limit, method]);
      } else {
        if(screen == 0){
          videos = fs.readFileSync('../build/streams.txt', 'utf-8').split('\n');
        }
        console.log(videos)
        for (let vid of videos) {
          if(screen == 0){
            vid = 'https://www.twitch.tv/' + vid
          }
          console.log(vid)
          //let o = await spawnProcess('streamlink', [`--player-args="--fs-screen=${screen} --no-border --keep-open=no --cache=yes --demuxer-max-bytes=250M"`, vid, quality]);
          let o = await spawnProcess('python', ['../py/stream_run.py', `--screen=${screen}`, vid, quality]);
          console.log(o)
        }
      }
    }
  } catch (error) {
    console.error('Error during file operations:', error);
  }
}
var z = 0
/*while(true){ 
  z += 1
  if(z%100==0){
    console.log(z)
  }
  if(z == 1){
    //let [ a, b, q,m,lm,c ] = process.argv // process.argv is array of arguments passed in consol
    */
setTimeout(() => {
  try {
    console.log("Start " + z)
    //let d = dex()
    get()
  } catch (e) {
    console.log(e)
  }
}, 500);


/*
//const data = await fetch(`https://www.youtube.com/[id]/live`)
//function findLiveStreamVideoId(channelId, cb){
    $.ajax({
        url: 'https://www.youtube.com/channel/'+channelId,
        type: "GET",
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Accept-Language': 'en-US, en;q=0.5'
      }}).done(function(resp) {
          
          //one method to find live video
          let n = resp.search(/\{"videoId[\sA-Za-z0-9:"\{\}\]\[,\-_]+BADGE_STYLE_TYPE_LIVE_NOW/i);
    
          //If found
          if(n>=0){
            let videoId = resp.slice(n+1, resp.indexOf("}",n)-1).split("\":\"")[1]
            return cb(videoId);
          }
    
          //If not found, then try another method to find live video
          n = resp.search(/https:\/\/i.ytimg.com\/vi\/[A-Za-z0-9\-_]+\/hqdefault_live.jpg/i);
          if (n >= 0){
            let videoId = resp.slice(n,resp.indexOf(".jpg",n)-1).split("/")[4]
            return cb(videoId);
          }
    
          //No streams found
          return cb(null, "No live streams found");
      }).fail(function() {
        return cb(null, "CORS Request blocked");
      });
    const isLive = (await data.text()).indexOf('isLiveBroadcast')
*/
