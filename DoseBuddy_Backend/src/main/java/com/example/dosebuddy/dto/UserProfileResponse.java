package com.example.dosebuddy.dto;

public class UserProfileResponse {
    private Long id;
    private String name;
    private String email;
    private String role;
    private String patientEmail;
    private String phone;
    private String dob;
    private String gender;
    private String emergencyContact;
    private boolean acceptedTerms;

    public UserProfileResponse() {}

    public UserProfileResponse(Long id, String name, String email, String role, String patientEmail,
                               String phone, String dob, String gender, String emergencyContact,
                               boolean acceptedTerms) {
        this.id = id;
        this.name = name;
        this.email = email;
        this.role = role;
        this.patientEmail = patientEmail;
        this.phone = phone;
        this.dob = dob;
        this.gender = gender;
        this.emergencyContact = emergencyContact;
        this.acceptedTerms = acceptedTerms;
    }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getRole() { return role; }
    public void setRole(String role) { this.role = role; }

    public String getPatientEmail() { return patientEmail; }
    public void setPatientEmail(String patientEmail) { this.patientEmail = patientEmail; }

    public String getPhone() { return phone; }
    public void setPhone(String phone) { this.phone = phone; }

    public String getDob() { return dob; }
    public void setDob(String dob) { this.dob = dob; }

    public String getGender() { return gender; }
    public void setGender(String gender) { this.gender = gender; }

    public String getEmergencyContact() { return emergencyContact; }
    public void setEmergencyContact(String emergencyContact) { this.emergencyContact = emergencyContact; }

    public boolean isAcceptedTerms() { return acceptedTerms; }
    public void setAcceptedTerms(boolean acceptedTerms) { this.acceptedTerms = acceptedTerms; }
}
