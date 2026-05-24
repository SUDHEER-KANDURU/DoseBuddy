package com.example.dosebuddy.service;

import com.example.dosebuddy.dto.PrescriptionResponseDto;
import com.example.dosebuddy.dto.PrescriptionResultDto;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.Base64;
import java.util.regex.*;
import java.util.stream.Collectors;

@Service
public class PrescriptionService {

    private final MedicineAiService aiService;    // Groq — text-based parsing (PDF/DOCX/TXT)
    private final GeminiOcrService  geminiOcr;    // Gemini — image OCR + vision parsing
    private final ObjectMapper objectMapper = new ObjectMapper();

    public PrescriptionService(MedicineAiService aiService, GeminiOcrService geminiOcr) {
        this.aiService = aiService;
        this.geminiOcr = geminiOcr;
    }


    public PrescriptionResponseDto processPrescription(MultipartFile file) throws Exception {

        String filename    = file.getOriginalFilename() == null ? "" : file.getOriginalFilename().toLowerCase();
        String contentType = file.getContentType()      == null ? "" : file.getContentType().toLowerCase();

        System.out.println("[PrescriptionService] Processing: " + filename + " (" + contentType + ")");

        if (isImage(filename, contentType)) {
            return processImage(file);
        }

        if (isPdf(filename, contentType)) {
            String text = extractPdfText(file);
            System.out.println("[PrescriptionService] PDF extracted text (" + text.length() + " chars)");
            return processExtractedText(text, "pdf");
        }

        if (isDocx(filename, contentType)) {
            String text = extractDocxText(file);
            System.out.println("[PrescriptionService] DOCX extracted text (" + text.length() + " chars)");
            return processExtractedText(text, "docx");
        }

        String text = new String(file.getBytes(), StandardCharsets.UTF_8);
        System.out.println("[PrescriptionService] TXT content (" + text.length() + " chars)");
        return processExtractedText(text, "txt");
    }

    private PrescriptionResponseDto processImage(MultipartFile file) throws Exception {
        String mimeType = resolveMimeType(file);
        String base64   = Base64.getEncoder().encodeToString(file.getBytes());

        // Step 1: Gemini vision — try direct image → JSON parse first
        String jsonFromVision = geminiOcr.parsePrescriptionFromImage(base64, mimeType);
        List<PrescriptionResultDto> medicines = parseJsonToMedicines(jsonFromVision);
        System.out.println("[PrescriptionService] Gemini vision parse: " + medicines.size() + " medicines");

        // Step 2: Gemini OCR — extract text, then parse with Gemini text parser
        if (medicines.isEmpty()) {
            String extractedText = geminiOcr.extractTextFromImage(base64, mimeType);
            System.out.println("[PrescriptionService] Gemini OCR extracted text (" + (extractedText != null ? extractedText.length() : 0) + " chars)");

            if (extractedText != null && !extractedText.isBlank()) {
                // Try Gemini text parse first (same provider, better context)
                String jsonFromGeminiText = geminiOcr.parsePrescriptionTextToJson(extractedText);
                medicines = parseJsonToMedicines(jsonFromGeminiText);
                System.out.println("[PrescriptionService] Gemini text parse: " + medicines.size() + " medicines");

                // Step 3: Groq text parse fallback
                if (medicines.isEmpty()) {
                    System.out.println("[PrescriptionService] Gemini text parse empty — trying Groq text parse");
                    String jsonFromGroq = aiService.parsePrescriptionToJson(extractedText);
                    medicines = parseJsonToMedicines(jsonFromGroq);
                    System.out.println("[PrescriptionService] Groq text parse: " + medicines.size() + " medicines");
                }

                // Step 4: local rule-based parser as last resort
                if (medicines.isEmpty()) {
                    System.out.println("[PrescriptionService] All AI parsers empty — using local rule-based parser");
                    medicines = localRuleBasedParse(extractedText);
                    System.out.println("[PrescriptionService] Local parse: " + medicines.size() + " medicines");
                }

                return buildResponse(medicines, extractedText);
            }
        }

        // No text could be extracted at all — try local parse on empty string (returns empty)
        System.out.println("[PrescriptionService] Image result: " + medicines.size() + " medicines");
        return buildResponse(medicines, "");
    }


    private PrescriptionResponseDto processExtractedText(String text, String source) {
        if (text == null || text.isBlank()) {
            System.out.println("[PrescriptionService] Empty text from " + source);
            return buildResponse(Collections.emptyList(), "");
        }

        List<PrescriptionResultDto> medicines = new ArrayList<>();

        try {
            String json = aiService.parsePrescriptionToJson(text);
            medicines = parseJsonToMedicines(json);
            System.out.println("[PrescriptionService] AI parse (" + source + "): " + medicines.size() + " medicines");
        } catch (Exception e) {
            System.err.println("[PrescriptionService] AI parse failed: " + e.getMessage());
        }

        if (medicines.isEmpty()) {
            System.out.println("[PrescriptionService] AI returned nothing — using local rule-based parser");
            medicines = localRuleBasedParse(text);
            System.out.println("[PrescriptionService] Local parse (" + source + "): " + medicines.size() + " medicines");
        }

        return buildResponse(medicines, text);
    }


    private List<PrescriptionResultDto> parseJsonToMedicines(String raw) {
        if (raw == null || raw.isBlank()) return Collections.emptyList();

        String cleaned = raw.trim();
        if (cleaned.startsWith("```")) {
            cleaned = cleaned.replaceAll("(?s)^```[a-zA-Z]*\\n?", "").replaceAll("```$", "").trim();
        }

        int start = cleaned.indexOf('[');
        int end   = cleaned.lastIndexOf(']');
        if (start == -1 || end == -1 || end <= start) {
            System.err.println("[PrescriptionService] No JSON array found in AI response");
            return Collections.emptyList();
        }
        cleaned = cleaned.substring(start, end + 1);

        try {
            JsonNode array = objectMapper.readTree(cleaned);
            if (!array.isArray()) return Collections.emptyList();

            List<PrescriptionResultDto> result = new ArrayList<>();
            Set<String> seen = new HashSet<>();

            for (JsonNode node : array) {
                String name = node.path("medicineName").asText("").trim();
                if (name.isEmpty()) continue;

                String key = name.toLowerCase().replaceAll("\\s+", " ");
                if (!seen.add(key)) continue;

                PrescriptionResultDto dto = new PrescriptionResultDto();
                dto.setMedicineName(cleanMedicineName(name));
                dto.setDosage(node.path("dosage").asText("As prescribed").trim());
                dto.setInstructions(node.path("instructions").asText("As directed").trim());

             
                JsonNode timesNode = node.path("times");
                List<String> times = new ArrayList<>();
                if (timesNode.isArray()) {
                    for (JsonNode t : timesNode) {
                        String ts = normalizeTimeString(t.asText("").trim());
                        if (!ts.isEmpty()) times.add(ts);
                    }
                }
                if (times.isEmpty()) times.add("08:00");
                dto.setTimes(times);

                result.add(dto);
            }
            return result;

        } catch (Exception e) {
            System.err.println("[PrescriptionService] JSON parse error: " + e.getMessage());
            System.err.println("[PrescriptionService] Raw JSON was: " + cleaned);
            return Collections.emptyList();
        }
    }


    private static final Pattern MED_LINE_PATTERN = Pattern.compile(
        "(?i)^\\s*" +
        "(?:(?:tab|cap|syr|inj|oint|gel|drop|susp|pwd|tab\\.|cap\\.|syr\\.|inj\\.)\\s*)?" +
        "([A-Za-z][A-Za-z0-9 /\\-+&]{1,60}?)" +   // medicine name
        "(?:\\s+(\\d+(?:\\.\\d+)?\\s*(?:mg|mcg|ml|g|iu|%|units?)\\b))?" + // optional dosage
        "(?:[\\s|,\\-]+(.+))?$"                     // rest (frequency/instructions)
    );

    private static final Map<String, String> FREQ_MAP = new LinkedHashMap<>();
    static {
        FREQ_MAP.put("morning",   "08:00");
        FREQ_MAP.put("breakfast", "08:00");
        FREQ_MAP.put("afternoon", "14:00");
        FREQ_MAP.put("lunch",     "13:00");
        FREQ_MAP.put("evening",   "18:00");
        FREQ_MAP.put("night",     "21:00");
        FREQ_MAP.put("bedtime",   "21:00");
        FREQ_MAP.put("hs",        "21:00");
        FREQ_MAP.put("noon",      "12:00");
    }

    private static final Map<String, List<String>> ABBREV_MAP = new LinkedHashMap<>();
    static {
        ABBREV_MAP.put("od",  List.of("08:00"));
        ABBREV_MAP.put("bd",  List.of("08:00", "21:00"));
        ABBREV_MAP.put("bid", List.of("08:00", "21:00"));
        ABBREV_MAP.put("tds", List.of("08:00", "14:00", "21:00"));
        ABBREV_MAP.put("tid", List.of("08:00", "14:00", "21:00"));
        ABBREV_MAP.put("qid", List.of("08:00", "12:00", "18:00", "21:00"));
        ABBREV_MAP.put("sos", List.of("08:00"));
        ABBREV_MAP.put("prn", List.of("08:00"));
        ABBREV_MAP.put("1-0-1", List.of("08:00", "21:00"));
        ABBREV_MAP.put("1-1-1", List.of("08:00", "14:00", "21:00"));
        ABBREV_MAP.put("0-0-1", List.of("21:00"));
        ABBREV_MAP.put("1-0-0", List.of("08:00"));
        ABBREV_MAP.put("0-1-0", List.of("14:00"));
        ABBREV_MAP.put("1-1-0", List.of("08:00", "14:00"));
        ABBREV_MAP.put("0-1-1", List.of("14:00", "21:00"));
    }

    private static final Set<String> SKIP_KEYWORDS = Set.of(
        "date", "patient", "doctor", "dr.", "clinic", "hospital", "address",
        "phone", "age", "sex", "weight", "diagnosis", "rx", "signature",
        "name:", "ref:", "reg.", "reg no", "prescription", "advice", "follow"
    );

    private List<PrescriptionResultDto> localRuleBasedParse(String text) {
        List<PrescriptionResultDto> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        String[] lines = text.split("\\r?\\n");
        for (String rawLine : lines) {
            String line = rawLine.trim();
            if (line.length() < 3) continue;

            String lower = line.toLowerCase();
            if (SKIP_KEYWORDS.stream().anyMatch(lower::contains)) continue;

            if (!Character.isLetter(line.charAt(0)) &&
                !line.toLowerCase().startsWith("tab") &&
                !line.toLowerCase().startsWith("cap") &&
                !line.toLowerCase().startsWith("syr") &&
                !line.toLowerCase().startsWith("inj")) {
                continue;
            }

            Matcher m = MED_LINE_PATTERN.matcher(line);
            if (!m.find()) continue;

            String rawName = m.group(1);
            if (rawName == null || rawName.trim().length() < 2) continue;

            String name = cleanMedicineName(rawName.trim());
            if (name.length() < 2) continue;

            String key = name.toLowerCase().replaceAll("\\s+", " ");
            if (!seen.add(key)) continue;

            String dosagePart = m.group(2) != null ? m.group(2).trim() : "";
            String rest       = m.group(3) != null ? m.group(3).trim() : "";

            List<String> times = extractTimesFromText(rest);

            String instructions = extractInstructions(rest);

            String dosage = buildDosage(rest, dosagePart);

            PrescriptionResultDto dto = new PrescriptionResultDto();
            dto.setMedicineName(name);
            dto.setDosage(dosage.isEmpty() ? "As prescribed" : dosage);
            dto.setInstructions(instructions.isEmpty() ? "As directed" : instructions);
            dto.setTimes(times.isEmpty() ? List.of("08:00") : times);
            result.add(dto);
        }

        return result;
    }

    private List<String> extractTimesFromText(String text) {
        if (text == null || text.isBlank()) return Collections.emptyList();
        String lower = text.toLowerCase();

        for (Map.Entry<String, List<String>> entry : ABBREV_MAP.entrySet()) {
            if (lower.contains(entry.getKey())) {
                return entry.getValue();
            }
        }

        List<String> times = new ArrayList<>();
        for (Map.Entry<String, String> entry : FREQ_MAP.entrySet()) {
            if (lower.contains(entry.getKey())) {
                if (!times.contains(entry.getValue())) {
                    times.add(entry.getValue());
                }
            }
        }
        return times;
    }

    private String extractInstructions(String text) {
        if (text == null) return "";
        Matcher m = Pattern.compile("\\(([^)]+)\\)").matcher(text);
        if (m.find()) return m.group(1).trim();

        String lower = text.toLowerCase();
        if (lower.contains("before food") || lower.contains("empty stomach")) return "Before food";
        if (lower.contains("after food")  || lower.contains("with food"))     return "After food";
        if (lower.contains("with water"))                                       return "With water";
        if (lower.contains("sos") || lower.contains("as needed"))              return "As needed (SOS)";
        return "";
    }

    private String buildDosage(String rest, String dosagePart) {
        if (!dosagePart.isEmpty()) return dosagePart;
        Matcher m = Pattern.compile("(?i)(\\d+(?:[./]\\d+)?)\\s*(?:tab(?:let)?s?|cap(?:sule)?s?|ml|mg|mcg|g)?").matcher(rest);
        if (m.find()) {
            String qty = m.group(1);
            if (qty.contains("/")) {
                String[] parts = qty.split("/");
                try {
                    double val = Double.parseDouble(parts[0]) / Double.parseDouble(parts[1]);
                    qty = String.valueOf(val);
                } catch (Exception ignored) {}
            }
            return qty + " tablet";
        }
        return "";
    }


    private String extractPdfText(MultipartFile file) {
        try (InputStream is = file.getInputStream();
             PDDocument doc = PDDocument.load(is)) {
            PDFTextStripper stripper = new PDFTextStripper();
            return stripper.getText(doc);
        } catch (Exception e) {
            System.err.println("[PrescriptionService] PDF extraction failed: " + e.getMessage());
            return "";
        }
    }


    private String extractDocxText(MultipartFile file) {
        try (InputStream is = file.getInputStream();
             XWPFDocument doc = new XWPFDocument(is)) {
            return doc.getParagraphs().stream()
                    .map(XWPFParagraph::getText)
                    .collect(Collectors.joining("\n"));
        } catch (Exception e) {
            System.err.println("[PrescriptionService] DOCX extraction failed: " + e.getMessage());
            return "";
        }
    }

    private PrescriptionResponseDto buildResponse(List<PrescriptionResultDto> medicines, String extractedText) {
        String quality;
        if (medicines.isEmpty())       quality = "POOR";
        else if (medicines.size() >= 4) quality = "GOOD";
        else                            quality = "MEDIUM";

        return new PrescriptionResponseDto(medicines, extractedText, quality);
    }

    private String cleanMedicineName(String name) {
        return name.replaceAll("(?i)^\\s*(tab\\.?|cap\\.?|syr\\.?|inj\\.?|oint\\.?|gel\\.?|susp\\.?|drops?\\.?)\\s*", "")
                   .replaceAll("\\s{2,}", " ")
                   .trim();
    }

    private String normalizeTimeString(String t) {
        if (t == null || t.isBlank()) return "";
        if (t.matches("\\d{2}:\\d{2}")) return t;
        if (t.matches("\\d:\\d{2}")) return "0" + t;
        String lower = t.toLowerCase();
        for (Map.Entry<String, String> e : FREQ_MAP.entrySet()) {
            if (lower.contains(e.getKey())) return e.getValue();
        }
        return t;
    }

    private String resolveMimeType(MultipartFile file) {
        String ct = file.getContentType();
        if (ct != null && !ct.isBlank()) return ct;
        String fn = file.getOriginalFilename() == null ? "" : file.getOriginalFilename().toLowerCase();
        if (fn.endsWith(".png"))  return "image/png";
        if (fn.endsWith(".jpg") || fn.endsWith(".jpeg")) return "image/jpeg";
        if (fn.endsWith(".webp")) return "image/webp";
        if (fn.endsWith(".gif"))  return "image/gif";
        return "image/jpeg";
    }

    private boolean isImage(String filename, String contentType) {
        return contentType.startsWith("image/") ||
               filename.endsWith(".png") || filename.endsWith(".jpg") ||
               filename.endsWith(".jpeg") || filename.endsWith(".webp") ||
               filename.endsWith(".gif") || filename.endsWith(".bmp");
    }

    private boolean isPdf(String filename, String contentType) {
        return filename.endsWith(".pdf") || contentType.contains("pdf");
    }

    private boolean isDocx(String filename, String contentType) {
        return filename.endsWith(".docx") || contentType.contains("word") ||
               contentType.contains("openxmlformats");
    }
}
