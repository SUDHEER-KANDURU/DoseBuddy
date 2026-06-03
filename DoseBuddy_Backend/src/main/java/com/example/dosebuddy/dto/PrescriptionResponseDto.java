package com.example.dosebuddy.dto;

import java.util.List;

public class PrescriptionResponseDto {

    private List<PrescriptionResultDto> medicines;
    private String extractedText;
    private String parseQuality;

    public PrescriptionResponseDto() {}

    public PrescriptionResponseDto(List<PrescriptionResultDto> medicines,
                                   String extractedText,
                                   String parseQuality) {
        this.medicines     = medicines;
        this.extractedText = extractedText;
        this.parseQuality  = parseQuality;
    }

    public List<PrescriptionResultDto> getMedicines()     { return medicines; }
    public void setMedicines(List<PrescriptionResultDto> medicines) { this.medicines = medicines; }

    public String getExtractedText()  { return extractedText; }
    public void setExtractedText(String extractedText) { this.extractedText = extractedText; }

    public String getParseQuality()   { return parseQuality; }
    public void setParseQuality(String parseQuality) { this.parseQuality = parseQuality; }
}
