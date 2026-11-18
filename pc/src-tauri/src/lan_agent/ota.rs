use super::{
    exchange_connection, query_status, read_before, read_peer, read_with_recovery, recover_pairing,
    Peer, IO_TIMEOUT,
};
use crate::usb_serial::{self, P4BoardModel, P4ChipTarget};
use crate::wireless_ota::{self, Boot, Error, Offer, Receipt, TransferId, TrustedOtaLink};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    net::{Shutdown, TcpStream},
    time::{Duration, Instant},
};

const MODE: u8 = 12;
const FRAME_TIMEOUT: Duration = Duration::from_secs(4);

struct Link {
    stream: TcpStream,
    key: aead::LessSafeKey,
    sequence: u32,
    id: String,
    revision: u16,
}

fn record_nonce(direction: u8, sequence: u32) -> aead::Nonce {
    let mut bytes = [0; 12];
    bytes[0] = direction;
    bytes[8..].copy_from_slice(&sequence.to_be_bytes());
    aead::Nonce::assume_unique_for_key(bytes)
}

fn malformed() -> Error {
    Error::Unknown("无线升级回执格式无效。".into())
}

impl Link {
    fn open(peer: &Peer) -> Result<Self, Error> {
        let (stream, key, admitted) = exchange_connection(peer, MODE, &[], Some(1), IO_TIMEOUT)
            .map_err(|err| Error::Unknown(err.to_string()))?;
        if admitted != [1] {
            return Err(Error::Rejected(
                "设备尚未授权当前配对电脑进行无线升级。".into(),
            ));
        }
        let mut link = Self {
            stream,
            key,
            sequence: 0,
            id: String::new(),
            revision: 0,
        };
        let reply = link.request(vec![0])?;
        if reply.len() != 8 {
            return Err(malformed());
        }
        link.revision = u16::from_be_bytes([reply[0], reply[1]]);
        link.id = format!(
            "p4-{}",
            reply[2..]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        Ok(link)
    }

    fn request(&mut self, mut payload: Vec<u8>) -> Result<Vec<u8>, Error> {
        let command = payload[0];
        let sequence = self.sequence;
        self.sequence += 1;
        let mut length = (payload.len() as u16).to_be_bytes();
        self.key
            .seal_in_place_append_tag(
                record_nonce(2, sequence),
                aead::Aad::from(length),
                &mut payload,
            )
            .map_err(|_| malformed())?;
        let response_timeout = match command {
            2 => Duration::from_secs(25),
            4 => Duration::from_secs(14),
            _ => FRAME_TIMEOUT,
        };
        let deadline = Instant::now() + response_timeout;
        self.stream
            .write_all(&length)
            .and_then(|_| self.stream.write_all(&payload))
            .and_then(|_| read_before(&mut self.stream, &mut length, deadline))
            .map_err(|err| Error::Unknown(err.to_string()))?;
        let count = u16::from_be_bytes(length) as usize;
        if !(1..=121).contains(&count) {
            return Err(malformed());
        }
        let mut reply = vec![0; count + 16];
        read_before(&mut self.stream, &mut reply, deadline)
            .map_err(|err| Error::Unknown(err.to_string()))?;
        let plain = self
            .key
            .open_in_place(
                record_nonce(3, sequence),
                aead::Aad::from(length),
                &mut reply,
            )
            .map_err(|_| malformed())?;
        match plain {
            [1, rest @ ..] => Ok(rest.to_vec()),
            [0, rest @ ..] => Err(Error::Rejected(String::from_utf8_lossy(rest).into_owned())),
            _ => Err(malformed()),
        }
    }
}

impl TrustedOtaLink for Link {
    fn board_id(&self) -> &str {
        &self.id
    }

    fn query_boot(&mut self) -> Result<Boot, Error> {
        let reply = self.request(vec![1])?;
        if reply.len() != 53
            || !matches!(reply[0], 0 | 1)
            || !reply[1..17].iter().all(u8::is_ascii_hexdigit)
        {
            return Err(malformed());
        }
        Ok(Boot {
            valid: reply[0] == 1,
            id: String::from_utf8_lossy(&reply[1..17]).into_owned(),
            partition: u32::from_be_bytes(reply[17..21].try_into().map_err(|_| malformed())?),
            digest: reply[21..].try_into().map_err(|_| malformed())?,
        })
    }

    fn begin(&mut self, offer: &Offer<'_>) -> Result<(), Error> {
        let mut frame = vec![2];
        frame.extend_from_slice(offer.prior.id.as_bytes());
        frame.extend_from_slice(&offer.prior.partition.to_be_bytes());
        frame.extend_from_slice(&offer.prior.digest);
        frame.extend_from_slice(&offer.id);
        frame.extend_from_slice(&offer.sha256);
        frame.extend_from_slice(&offer.installed_digest);
        frame.extend_from_slice(&offer.bytes.to_be_bytes());
        frame.extend_from_slice(&offer.revision_min.to_be_bytes());
        frame.extend_from_slice(&offer.revision_max.to_be_bytes());
        self.request(frame)?
            .is_empty()
            .then_some(())
            .ok_or_else(malformed)
    }

    fn chunk(&mut self, id: TransferId, sequence: u32, bytes: &[u8]) -> Result<(), Error> {
        let mut frame = Vec::with_capacity(21 + bytes.len());
        frame.push(3);
        frame.extend_from_slice(&id);
        frame.extend_from_slice(&sequence.to_be_bytes());
        frame.extend_from_slice(bytes);
        self.request(frame)?
            .is_empty()
            .then_some(())
            .ok_or_else(malformed)
    }

    fn commit(&mut self, id: TransferId) -> Result<Receipt, Error> {
        let mut frame = vec![4];
        frame.extend_from_slice(&id);
        let reply = self.request(frame)?;
        if reply.len() != 36 {
            return Err(malformed());
        }
        Ok(Receipt {
            partition: u32::from_be_bytes(reply[..4].try_into().map_err(|_| malformed())?),
            installed_digest: reply[4..].try_into().map_err(|_| malformed())?,
        })
    }

    fn close(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

fn error_text(error: Error) -> String {
    match error {
        Error::Image => "内置无线固件校验失败。".into(),
        Error::Device => "目标设备或启动身份已改变。".into(),
        Error::Rejected(message) => format!("设备拒绝无线升级（{message}）"),
        Error::Unknown(message) => format!("无线升级结果未确认（{message}）"),
    }
}

fn install_bundled(
    app: &tauri::AppHandle,
    usb: &usb_serial::UsbSerialManager,
    expected_boot_id: &str,
) -> Result<String, String> {
    super::require_no_usb(usb)?;
    let (mut peer, status) = read_with_recovery(query_status, "无法读取已配对的 Wi-Fi 设备。")?;
    if !status.wireless_ota || !status.control_trusted || status.boot_id != expected_boot_id {
        return Err("当前设备未开放无线升级，或启动身份已变化。".into());
    }
    // Resolve and inspect the bundled image outside of the transfer session.
    let mut link = Link::open(&peer).map_err(error_text)?;
    let revision = link.revision;
    let id = link.id.clone();
    link.close();
    let target = P4ChipTarget::Revision(revision);
    let board = P4BoardModel::Wifi6;
    let path = crate::bundled_p4_firmware_path(
        app,
        usb_serial::bundled_resource_for_device(board, target),
    )?;
    let info = usb_serial::inspect_firmware_image(&path, target)?;
    if !board.image_version_matches(&info.version) {
        return Err("内置固件的板型标记不匹配。".into());
    }
    if crate::compare_firmware_versions(&status.firmware, &info.version)?
        != std::cmp::Ordering::Less
    {
        return Err("设备固件已是最新版本。".into());
    }
    let bytes = std::fs::read(&path).map_err(|err| err.to_string())?;
    // Current bundled ESP images append the native digest after the final segment.
    let end = bytes
        .len()
        .checked_sub(32)
        .filter(|end| *end >= 24)
        .ok_or_else(|| error_text(Error::Image))?;
    let digest: [u8; 32] = bytes[end..]
        .try_into()
        .map_err(|_| error_text(Error::Image))?;
    if bytes[23] != 1 || <[u8; 32]>::from(Sha256::digest(&bytes[..end])) != digest {
        return Err(error_text(Error::Image));
    }
    let image =
        wireless_ota::VerifiedImage::new(&bytes, Sha256::digest(&bytes).into(), digest, revision)
            .map_err(error_text)?;
    let mut transfer = [0; 16];
    SystemRandom::new()
        .fill(&mut transfer)
        .map_err(|_| "无法创建无线升级会话。")?;
    let mut link = Link::open(&peer).map_err(error_text)?;
    if link.id != id
        || link.revision != revision
        || link.query_boot().map_err(error_text)?.id != expected_boot_id
    {
        return Err(error_text(Error::Device));
    }
    super::require_no_usb(usb)?;
    let pending = wireless_ota::install(&mut link, &id, transfer, image).map_err(error_text)?;
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut next_scan = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1400));
        if let Ok(mut live) = Link::open(&peer) {
            if live
                .query_boot()
                .is_ok_and(|boot| pending.validated(live.board_id(), &boot))
            {
                return Ok(info.version);
            }
        } else if Instant::now() >= next_scan {
            let _ = recover_pairing(&peer);
            if let Ok(Some(recovered)) = read_peer() {
                if recovered.key.as_ref() != peer.key.as_ref() {
                    return Err("无线升级期间配对已变更，当前镜像状态尚未确认。".into());
                }
                peer = recovered;
            }
            next_scan = Instant::now() + Duration::from_secs(8);
        }
    }
    Err("设备已收到升级，但新固件启动状态尚未确认。".into())
}

#[tauri::command]
pub(crate) async fn lan_update_bundled_firmware(
    app_handle: tauri::AppHandle,
    expected_boot_id: String,
    usb_manager: tauri::State<'_, usb_serial::UsbSerialManager>,
) -> Result<String, String> {
    let usb = usb_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_bundled(&app_handle, &usb, &expected_boot_id)
    })
    .await
    .map_err(|_| "无线升级任务未完成。")?
}
